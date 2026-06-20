# Reporting & Analytics Backend — Design Brief

**Author:** Backend/Platform Engineering · **Date:** 2026-06-20
**Scope:** The data/query/aggregation/storage layer powering custom dashboards, a report builder, funnel/velocity/forecast reports, and goals. (Product owns reporting *features*; this brief owns the backend.)

---

## Current state (verified from repo)

- **Dashboard is 100% ad-hoc at request time.** `src/app/(app)/dashboard/page.tsx` runs 7 parallel Prisma queries on every load (`force-dynamic`, no cache), then **pulls full rows into Node and reduces in JS**: it does `db.deal.findMany({ where: { orgId, status: "OPEN" }})` and computes `pipelineValue`, per-stage sums, and win-rate with `.reduce()`/`.filter()` in application code (lines 15–39). This loads every open/won/lost deal row per request — O(deals) memory and transfer, no DB-side aggregation.
- **No stage-transition history exists.** Deal moves happen in `src/server/actions/deals.ts`:
  - `moveDealToStage` (line 76) does `db.deal.update({ data: { stageId }})` — overwrites `stageId`, **prior stage is lost**.
  - `setDealStatus` (line 89) uses `db.deal.updateMany({ where: { id, orgId }, data: { status }})` — **no before-state is read**, so we cannot know the old status. Capturing transitions requires reading the prior row first.
  - `createDeal`/`updateDeal` set `stageId`/`status` directly with no event emission.
  - The `Deal` model has only `createdAt`/`updatedAt` — no `stageEnteredAt`, no audit trail.
- **No saved report / dashboard / goal models** in `prisma/schema.prisma`. Models are `Deal`, `Activity`, `Contact`, `Company`, `PipelineStage`, `Tag`, plus auth/tenancy. Every domain row carries `orgId` and is indexed `@@index([orgId, ...])`; `requireOrg()` (`src/lib/tenant.ts`) is the single tenant gate. There is **no Postgres RLS** — isolation is application-enforced via `where: { orgId }`.
- **No pre-aggregation, no jobs, no materialized views, no warehouse.** Single Postgres 16 on Vercel; `db.ts` is a plain `PrismaClient` singleton.

**Implication:** funnel conversion, time-in-stage/velocity, and win-rate *trends* are **impossible to compute today** — the data was never recorded. That is the foundational gap and the ordering constraint for everything below.

---

## Reference data models (benchmarked)

- **Pipedrive Insights** uses a three-axis report definition: **measure-by** (what is counted/summed — e.g. deal value, count, emails sent), **view-by** (the primary grouping dimension — e.g. stage, owner, month), and **segment-by** (a secondary breakdown). A report = filter view + visual builder (measure/view/segment) + table view. ([Pipedrive Insights feature](https://support.pipedrive.com/en/article/insights-feature); [Datomni Insights guide](https://insights.datomni.com/blog/pipedrive-insights-report/))
- **HubSpot custom report builder** treats each CRM object as a relational table; a report joins objects (cross-object), applies **filters**, then picks **measures** (numeric, Y-axis, aggregated) and **dimensions** (grouping, X-axis, any type). Cross-object/funnel reporting is gated to higher tiers; HubSpot auto-detects valid object relationships. ([HubSpot custom report builder](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder); [Huble: cross-object reporting](https://huble.com/blog/hubspots-updated-report-builder-and-cross-object-reporting))

Both converge on the same primitive: **{ source object(s), filters[], measure(s), dimension(s) }** as a serializable report definition. Our `Report.spec` JSON adopts this directly.

---

## Capabilities

### 1. DealStageEvent — append-only stage/status transition log
**What it enables:** The system of record for *every* stage and status change, with timestamps. This is the prerequisite for funnel conversion, time-in-stage/velocity, win-rate-over-time, and historical "as-of" pipeline. Without it, none of capabilities 4–6 can exist.

**Design**
- Append-only table; one row per transition. Capture in the four mutation paths in `deals.ts`. **Critical fix:** `setDealStatus` must first read the existing deal (it currently uses `updateMany` with no read) so `fromStatus`/`fromStageId` are known; wrap read+update+event in a single `db.$transaction` to stay consistent. `createDeal` emits a seed event (`from*` = null). Optionally also reconstruct history for existing deals once from `createdAt` (single backfill row each).

```prisma
model DealStageEvent {
  id          String      @id @default(cuid())
  orgId       String
  dealId      String
  fromStageId String?
  toStageId   String?
  fromStatus  DealStatus?
  toStatus    DealStatus?
  valueAt     Decimal     @db.Decimal(12, 2)   // deal value snapshot at transition
  actorId     String?                          // user who made the change
  changedAt   DateTime    @default(now())

  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  deal Deal         @relation(fields: [dealId], references: [id], onDelete: Cascade)

  @@index([orgId, changedAt])
  @@index([dealId, changedAt])              // per-deal timeline (for time-in-stage)
  @@index([orgId, toStageId, changedAt])    // funnel "entered stage" scans
}
```
- Add a denormalized `Deal.stageEnteredAt DateTime?` updated on each move so "current time-in-stage" is a cheap `now() - stageEnteredAt` without scanning events.
- Emit via a tiny `recordStageEvent()` helper called inside existing actions (no queue needed at current scale; single Postgres, same transaction).

**Reference evidence:** Stage-to-stage conversion, time-in-stage, and velocity are the three core pipeline metrics and all require recorded transitions; time-in-stage is computed by diffing entry/exit timestamps per stage. ([Prospeo: funnel velocity](https://prospeo.io/s/sales-funnel-velocity); [Data-Mania: time-to-conversion](https://www.data-mania.com/blog/time-to-conversion-metrics-for-funnel-stages/))

**Effort:** S · **Deps:** none (pure additive migration + 4 action edits). **Tier:** **Foundation**

---

### 2. On-the-fly aggregation layer (replace JS reduces with DB-side GROUP BY)
**What it enables:** Immediate correctness/scale win for the existing dashboard and all "current snapshot" tiles — independent of any history table. Stops shipping every deal row to Node.

**Design**
- Replace `findMany`+`.reduce()` in `dashboard/page.tsx` with `db.deal.groupBy` or a `$queryRaw` rollup. Co-locate all read aggregations in `src/server/analytics/` query functions (keep the `orgId` filter mandatory in every one).

```sql
-- Pipeline value + count by stage, win-rate inputs, in ONE round trip:
SELECT s.id, s.name, s.color, s."order",
       COALESCE(SUM(d.value) FILTER (WHERE d.status = 'OPEN'), 0) AS open_value,
       COUNT(d.id)          FILTER (WHERE d.status = 'OPEN')      AS open_count,
       COUNT(d.id)          FILTER (WHERE d.status = 'WON')       AS won_count,
       COUNT(d.id)          FILTER (WHERE d.status = 'LOST')      AS lost_count
FROM   "PipelineStage" s
LEFT JOIN "Deal" d ON d."stageId" = s.id AND d."orgId" = s."orgId"
WHERE  s."orgId" = $1
GROUP BY s.id
ORDER BY s."order";   -- GROUPING SETS / ROLLUP for subtotal+grand-total in one pass
```
- Add **partial indexes** to make the hot filters index-only:
  `CREATE INDEX deal_open_idx ON "Deal"(orgId, stageId) WHERE status = 'OPEN';`
- Wrap each result in Next.js `unstable_cache`/`revalidateTag('analytics:'+orgId)`, invalidated by the deal/activity actions that already call `revalidatePath`.

**Reference evidence:** Postgres `FILTER`/`GROUPING SETS`/`ROLLUP` compute multiple aggregates and subtotals in a single scan; pushing aggregation to SQL avoids transferring/looping rows in app code, the standard fix for ad-hoc dashboards. ([Postgres aggregate strategy overview](https://stormatics.tech/blogs/postgresql-materialized-views-when-caching-your-query-results-makes-sense))

**Effort:** S · **Deps:** none (works before #1). **Tier:** **Foundation**

---

### 3. Report & Dashboard definition model (saved measure/dimension/filter)
**What it enables:** A persisted, shareable report builder and custom dashboards — the Pipedrive/HubSpot-style "save a view." Decouples *what to compute* (definition) from *how* (the query engine in #7).

**Design** — store the report as a validated JSON `spec` (Zod-typed), not a rigid column-per-option schema, mirroring HubSpot's relational/measures-dimensions-filters model and Pipedrive's measure/view/segment.

```prisma
enum ReportType { TABLE BAR LINE FUNNEL NUMBER }

model Report {
  id        String     @id @default(cuid())
  orgId     String
  name      String
  type      ReportType @default(BAR)
  source    String     // "deal" | "activity" | "contact"
  spec      Json       // { measures:[{field,agg}], dimensions:[...], segment?, filters:[...], dateRange }
  ownerId   String?
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt
  org   Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  cards DashboardCard[]
  @@index([orgId])
}

model Dashboard {
  id     String  @id @default(cuid())
  orgId  String
  name   String
  layout Json    // grid positions
  cards  DashboardCard[]
  org    Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([orgId])
}

model DashboardCard {
  id          String @id @default(cuid())
  dashboardId String
  reportId    String
  position    Json
  dashboard   Dashboard @relation(fields: [dashboardId], references: [id], onDelete: Cascade)
  report      Report    @relation(fields: [reportId], references: [id], onDelete: Cascade)
}
```
- `spec` shape (Zod-validated server-side): `measures: [{ field, agg: sum|count|avg }]`, `dimensions: [field]` (view-by), optional `segment` (segment-by), `filters: [{ field, op, value }]`, `dateRange`. Whitelist allowed fields/aggs per `source` to prevent SQL injection when the engine (#7) compiles them.

**Reference evidence:** Pipedrive report = measure-by + view-by + segment-by + filters; HubSpot report = source object(s) + filters + measures (numeric/aggregated) + dimensions (grouping). A serialized `{measures,dimensions,filters}` spec is the shared primitive. ([Pipedrive Insights](https://support.pipedrive.com/en/article/insights-feature); [HubSpot report builder](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder))

**Effort:** M · **Deps:** #7 to execute specs; usable for table reports with #2 patterns first. **Tier:** **Core**

---

### 4. Funnel & conversion report (stage-to-stage drop-off)
**What it enables:** "Of deals that entered stage N, what % reached stage N+1," plus overall lead→won conversion — the headline pipeline-health report.

**Design** — derive from `DealStageEvent` (#1). "Entered stage X" = any event with `toStageId = X` within the date window; conversion = distinct deals reaching later stages ÷ deals at the reference stage.

```sql
WITH entered AS (
  SELECT e."dealId", e."toStageId", MIN(e."changedAt") AS first_entered
  FROM "DealStageEvent" e
  WHERE e."orgId" = $1 AND e."changedAt" >= $2
  GROUP BY e."dealId", e."toStageId"
)
SELECT s."order", s.name,
       COUNT(DISTINCT en."dealId") AS deals_entered
FROM "PipelineStage" s
LEFT JOIN entered en ON en."toStageId" = s.id
WHERE s."orgId" = $1
GROUP BY s.id ORDER BY s."order";
-- conversion% per step = LAG()/LEAD() over the ordered stage counts (window function)
```
- Use `LAG()`/`LEAD()` window functions over the stage-ordered counts to compute step conversion and cumulative drop-off in one pass.

**Reference evidence:** Funnel/conversion analysis is canonically a stack of per-stage window functions plus distinct counts of the entity at each cutoff; rolling windows (1/7/30d) give time-bounded conversion. ([Silota: SQL funnel analysis](http://www.silota.com/docs/recipes/sql-funnel-analysis.html); [Optimizely: funnel SQL](https://www.optimizely.com/insights/blog/funnel-analysis-sql/))

**Effort:** M · **Deps:** **#1 (hard)**. **Tier:** **Core**

---

### 5. Velocity & time-in-stage report (bottleneck detection)
**What it enables:** Average days a deal spends in each stage, sales-cycle length, and sales velocity — flags stages running 2×+ benchmark.

**Design** — pair consecutive events per deal with `LEAD()` to get each interval's duration; aggregate by stage. Current open deals' in-stage time comes from `Deal.stageEnteredAt` (denormalized in #1) without scanning events.

```sql
WITH spans AS (
  SELECT "dealId", "toStageId" AS stage_id, "changedAt" AS entered,
         LEAD("changedAt") OVER (PARTITION BY "dealId" ORDER BY "changedAt") AS exited
  FROM "DealStageEvent" WHERE "orgId" = $1
)
SELECT stage_id,
       AVG(EXTRACT(EPOCH FROM (COALESCE(exited, now()) - entered))/86400) AS avg_days_in_stage,
       COUNT(*) AS samples
FROM spans GROUP BY stage_id;
```
- Sales velocity = `(open_deals × win_rate × avg_deal_value) / avg_cycle_days`, all derivable from #1 + #2 outputs.

**Reference evidence:** Time-in-stage = entry/exit timestamp diff per stage; velocity = `(Opportunities × Win Rate × Avg Deal Size) / Sales Cycle Length`; map time-in-stage vs benchmark to find bottlenecks. ([Prospeo: velocity formula](https://prospeo.io/s/sales-funnel-velocity); [Data-Mania](https://www.data-mania.com/blog/time-to-conversion-metrics-for-funnel-stages/))

**Effort:** M · **Deps:** **#1 (hard)**. **Tier:** **Core**

---

### 6. Forecast report & Goals (target vs actual)
**What it enables:** Weighted/expected-close pipeline forecast and goal tracking (e.g. "$X won this quarter per owner") with progress against target.

**Design**
- **Forecast (no history needed):** weighted pipeline = `SUM(value × stage_probability)` filtered by `closeDate` window. Add an optional `PipelineStage.probability Int?` (0–100); group by close-month/owner. Run as on-the-fly SQL (#2) or save as a `Report` (#3).
- **Goals model:**
```prisma
enum GoalMetric { WON_VALUE WON_COUNT ACTIVITIES_DONE }
model Goal {
  id        String     @id @default(cuid())
  orgId     String
  metric    GoalMetric
  target    Decimal    @db.Decimal(14, 2)
  period    String     // "2026-Q3" | "2026-07"
  ownerId   String?    // null = team goal
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([orgId, period])
}
```
- "Actual" is computed against `Deal`/`Activity` (or the summary table in #8) for the period and compared to `target`.

**Reference evidence:** Pipedrive/HubSpot both ship goal/forecast objects alongside reports; forecast is a probability-weighted sum over open pipeline by close date — a deterministic aggregation, not requiring transition history. ([Pipedrive Insights feature](https://support.pipedrive.com/en/article/insights-feature))

**Effort:** M · **Deps:** #2; Goals actuals improved by #8. **Tier:** **Core**

---

### 7. Spec→SQL query engine (compile saved reports safely)
**What it enables:** Turns a `Report.spec` (#3) into a parameterized, tenant-scoped SQL query — the runtime that makes the builder actually run, with no SQL injection.

**Design**
- A compiler in `src/server/analytics/engine.ts`: validate `spec` against a **per-source field whitelist** (allowed columns, agg functions, join paths), then build `SELECT <measures> FROM <source> [joins] WHERE orgId = $1 AND <filters> GROUP BY <dimensions>`. Always inject `orgId` as a bound param — never interpolate identifiers from user input; map spec field names → real columns via a static registry.
- Parameterize all values via `Prisma.sql`/`$queryRaw` placeholders. Enforce a `LIMIT` and a statement timeout for safety.
- Cache compiled results per `(orgId, reportId, specHash, dateRange)`.

**Reference evidence:** Both reference builders compile a stored `{measures,dimensions,filters}` definition into a query at run time; the relational-table mental model (HubSpot) maps cleanly to a whitelist-driven SQL generator. ([HubSpot report builder](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder))

**Effort:** L · **Deps:** #3. **Tier:** **Core**

---

### 8. Pre-aggregation: materialized views / summary tables refreshed by jobs
**What it enables:** Sub-100ms dashboards and trend reports as data grows, by precomputing daily rollups instead of scanning raw deals/events per request.

**Design**
- Daily grain **summary table** (preferred over a bare matview because Postgres matviews only do full `REFRESH`, no incremental, and lock-light `REFRESH CONCURRENTLY` still recomputes everything):
```prisma
model DailyDealMetric {
  orgId      String
  day        DateTime @db.Date
  stageId    String?
  ownerId    String?
  openValue  Decimal  @db.Decimal(14, 2)
  wonValue   Decimal  @db.Decimal(14, 2)
  wonCount   Int
  lostCount  Int
  @@id([orgId, day, stageId, ownerId])
  @@index([orgId, day])
}
```
- Refresh via a Vercel **Cron** route (hourly/nightly) that upserts the last N days from raw tables (incremental by `day`), per `orgId`. Start with a matview for win-rate-trend if a quick win is needed; graduate to the summary table when refresh cost or staleness hurts.
- Read path: trend/Goals queries hit `DailyDealMetric`; "today/live" tiles still use on-the-fly (#2) so current data is never stale.

**Reference evidence:** Matviews suit expensive rollups with bounded, scheduled staleness but **have no incremental mode and rebuild fully** — making summary tables the better fit once source tables change often; hourly cron refresh is "fresh enough" for analytics. ([Stormatics: matviews](https://stormatics.tech/blogs/postgresql-materialized-views-when-caching-your-query-results-makes-sense); [BoldBI: summary tables vs matviews](https://support.boldbi.com/kb/article/15430/summary-tables-vs-materialized-views-a-comparison))

**Effort:** M · **Deps:** #1 (for event-derived metrics), #2 (query parity). **Tier:** **Strategic Bet**

---

### 9. Multi-tenant aggregation isolation & caching
**What it enables:** Guarantees one org never reads another's aggregates, and keeps per-tenant cache correctness as reporting traffic grows.

**Design**
- **Isolation:** every analytics query function takes `orgId` as a mandatory first arg and binds it as `$1`; the #7 engine refuses any spec it can't scope. Consider enabling **Postgres RLS** as defense-in-depth (`USING (orgId = current_setting('app.org_id'))`) set per request via `SET LOCAL` in a transaction — catches a missing `WHERE orgId` even if app code regresses. (Today isolation is app-only via `requireOrg()`/`where:{orgId}`.)
- **Caching:** key all cached aggregates by `orgId` (`unstable_cache` tag `analytics:{orgId}` / `report:{orgId}:{reportId}:{specHash}`); invalidate on the deal/activity actions that already `revalidatePath`. Never share a cache entry across tenants. Beware prepared-statement plan reuse if RLS uses `current_setting()`.

**Reference evidence:** RLS enforces tenant isolation at the engine level even when app code omits the filter, but multi-tenancy must propagate through caches/workers/analytical pipelines; per-tenant cache keys are required to avoid cross-tenant leakage. ([Nile: multi-tenant RLS](https://www.thenile.dev/blog/multi-tenant-rls); [ClickHouse: multi-tenant SaaS on Postgres](https://clickhouse.com/resources/engineering/multi-tenant-saas-postgres-architecture))

**Effort:** S–M · **Deps:** cuts across #2/#7/#8. **Tier:** **Foundation**

---

### 10. (Strategic) Warehouse / OLAP offload — defer until thresholds hit
**What it enables:** Interactive cross-tenant/large-scale analytics without taxing the transactional Postgres — only when Postgres + summary tables stop coping.

**Design**
- **Stay on Postgres** for the foreseeable Smart-CRM scale: a single-tenant CRM's deals/events are in the thousands–low-millions of rows; #1+#2+#8 cover this comfortably. Do **not** add ClickHouse/DuckDB/Tinybird now — it adds an ETL pipeline, a second store to keep tenant-isolated, and operational cost with no payoff at current volume.
- **Trip-wires to revisit:** event/summary tables exceed ~tens of millions of rows; p95 dashboard query > ~1s after indexing + summary tables; many concurrent heavy report runs degrade OLTP latency; or product wants embedded BI / large ad-hoc exploration. Then evaluate **DuckDB** (embedded, single-node, cheapest for periodic/export workloads) before **ClickHouse/Tinybird** (managed, high-concurrency user-facing analytics, but heavier ops). Feed it from `DealStageEvent` (already an append-only event stream — natural CDC source).

**Reference evidence:** DuckDB fits small–medium single-node datasets and interactive analysis; ClickHouse/Tinybird target real-time, high-concurrency, hundreds-of-GB+ multi-tenant analytics — overkill until those thresholds; column stores are where heavy analytical workloads belong once Postgres OLTP is strained. ([Tinybird: ClickHouse vs DuckDB](https://www.tinybird.co/blog/clickhouse-vs-duckdb-nodes); [CloudRaft: ClickHouse vs DuckDB](https://www.cloudraft.io/blog/clickhouse-vs-duckdb); [ClickHouse: multi-tenant SaaS on Postgres](https://clickhouse.com/resources/engineering/multi-tenant-saas-postgres-architecture))

**Effort:** L · **Deps:** #1, #8, real scale signal. **Tier:** **Strategic Bet**

---

## Top 3 picks
1. **DealStageEvent (#1)** — the one irreversible gap: without recording transitions now, funnel/velocity/win-rate-trend can never be built retroactively. Small effort, unblocks #4/#5/#8. Fix `setDealStatus`'s `updateMany` so before-state is captured.
2. **On-the-fly aggregation layer + partial indexes (#2)** — replaces the per-request "load all deals into Node and reduce" in `dashboard/page.tsx` with DB-side `GROUP BY`/`FILTER`; immediate correctness/scale win, zero new dependencies.
3. **Report/Dashboard definition model + spec→SQL engine (#3 + #7)** — the saved measure/dimension/filter builder (Pipedrive/HubSpot parity) that turns one-off queries into a reusable, tenant-safe reporting product.
