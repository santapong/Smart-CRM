# Smart-CRM — Caching & Performance Design Brief

**Scope:** Keeping Smart-CRM fast as data and tenants grow — serverless DB connection management, pagination, indexing, N+1 elimination, caching tiers, invalidation, and observability.
**Stack:** Next.js 15 (RSC + server actions) · Prisma 5 · Postgres 16 · Vercel (serverless).
**Date:** 2026-06-20 · **Status:** Research/design only (no repo changes).

---

## Current-state findings (from the repo)

These ground every recommendation below; cited by file.

- **Prisma singleton, no pooling/logging hooks** — `src/lib/db.ts` constructs a plain `PrismaClient` with only `log: ["error"]` (or `["warn","error"]` in dev). No `$on("query")` slow-query hook, no Accelerate, no `connection_limit`/`pool_timeout` tuning. On Vercel each warm lambda holds its own pool → connection-count multiplies with concurrency.
- **`directUrl` missing from schema** — `prisma/schema.prisma` `datasource` block only sets `url = env("DATABASE_URL")`. `src/env.ts:7` already *declares* `DIRECT_URL` (optional) but the schema never consumes it. With a pooler (PgBouncer transaction mode) in `DATABASE_URL`, migrations/introspection will break or run through the pooler. This is the single biggest pre-pooler gap.
- **No real pagination — hard caps instead** — `contacts/page.tsx:44` and `activities/page.tsx:17` use `take: 200`; `companies/page.tsx:18` `take: 200`; `deals/page.tsx` (open deals) and `deals/[id]` form-loader contact/company lists have **no `take` at all** (unbounded `findMany`). All list pages set `export const dynamic = "force-dynamic"` (6 files), so every render hits Postgres uncached.
- **Over-fetching / N+1-shaped includes** — `deals/page.tsx:18` `include: { contact: true, company: true }` (whole rows, all columns incl. `notes @db.Text`); `contacts/page.tsx:41` `tags: { include: { tag: true } }`; detail pages load full related rows + unbounded option lists (`deals/[id]/page.tsx:17-18` load *every* contact & company in the org just to populate form dropdowns).
- **Dashboard pulls full tables into JS to aggregate** — `dashboard/page.tsx:17-19` runs three `findMany` for OPEN/WON/LOST deals and then `reduce()`s in Node to compute pipeline sums, win rate, and per-stage chart values (`:30-39`). This transfers every deal row over the wire to compute numbers Postgres can return with `groupBy`/`aggregate`.
- **Search not index-friendly** — `contacts/page.tsx:30-34` and `server/actions/search.ts:24-40` use `OR` of `contains` + `mode: "insensitive"` across firstName/lastName/email. B-tree indexes (`@@index([orgId, lastName])`, `[orgId, email]`) can't serve leading-wildcard `ILIKE '%q%'` → sequential scan within org.
- **Index/sort mismatches** — common sort paths aren't covered: deals list filters `status:OPEN` + `orderBy createdAt desc` (index is `[orgId, status]`, no `createdAt`); contacts sort `[lastName, firstName]` (index is `[orgId, lastName]` only); activities sort `[completedAt, dueAt, createdAt]` (indexes are single-column `[orgId, dueAt]` / `[orgId, completedAt]`).
- **Invalidation is path-based and broad** — actions call `revalidatePath("/contacts")`, `("/deals")`, etc. (e.g. `server/actions/contacts.ts:39`, `deals.ts:44`). No tag-based, org-scoped invalidation — and because pages are `force-dynamic`, `revalidatePath` is largely a no-op today.

---

## Capabilities

### 1. Serverless DB connection management (pooler + `directUrl`)
- **What it enables:** Survive Vercel concurrency without exhausting Postgres connections; safe migrations.
- **Design:** Put a transaction-mode pooler in front of Postgres and split URLs:
  - `DATABASE_URL` → pooled endpoint with `?pgbouncer=true&connection_limit=1&pool_timeout=20` (per-lambda pool of 1; the external pooler does the real pooling). Options: **Neon pooled endpoint**, **Supabase/PgBouncer**, or **Prisma Accelerate** (managed pooler + global query cache, HTTP-based — also shrinks cold starts).
  - `DIRECT_URL` → unpooled 5432 endpoint, consumed by adding `directUrl = env("DIRECT_URL")` to the `datasource` block in `schema.prisma` (currently absent) so `prisma migrate`/introspection bypass the pooler. `src/env.ts` already validates `DIRECT_URL`.
  - Keep the `globalForPrisma` singleton (already correct in `db.ts`) to reuse the client across warm invocations.
- **Reference evidence:** Prisma "Databases connections" & "Connect your DB / serverless" recommend an external pooler for FaaS, `connection_limit=1` per function, and `directUrl` for migrations; `pgbouncer=true` disables prepared statements for transaction-mode poolers ([Prisma: Database connections](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections), [Prisma: Deploy to Vercel](https://www.prisma.io/docs/orm/prisma-client/deployment/serverless/deploy-to-vercel), [Prisma: Connection management](https://www.prisma.io/docs/guides/performance-and-optimization/connection-management), [Prisma Accelerate / connection pooling](https://www.prisma.io/docs/postgres/database/connection-pooling), [community fix guide](https://humansfix.ai/guides/v0/prisma-connection-pool-exhausted-vercel)).
- **Effort:** S (config + 1 schema line) · **Deps:** pooler provider (Neon/Supabase/Accelerate); set Vercel env vars.
- **Tier:** **Foundation.**

### 2. Cursor pagination for large lists
- **What it enables:** Constant-time list loads regardless of table size; replaces silent `take: 200` truncation and unbounded queries.
- **Design:** Convert contacts/deals/companies/activities lists to keyset/cursor pagination: `findMany({ take: 25, ...(cursor && { cursor: { id: cursor }, skip: 1 }), orderBy: [<sortKey>, { id: "asc" }] })`, returning the last row's id as `nextCursor`. Always include a unique tiebreaker (`id`) in `orderBy`. Drive the cursor through `searchParams` (RSC-friendly). For the deal-form dropdowns in `deals/[id]`/`contacts/new`, replace "load all contacts/companies" with a typeahead/async server action (paged search) instead of a full `findMany`.
- **Reference evidence:** Prisma docs recommend cursor pagination for large datasets (offset must scan/skip all preceding rows; cursor uses an indexed column) ([Prisma: Pagination](https://www.prisma.io/docs/orm/prisma-client/queries/pagination), [Efficient Prisma pagination — M. Skelton](https://mskelton.dev/blog/efficient-prisma-pagination), [Cursor vs offset pagination](https://medium.com/@wasimxaman13/cursor-vs-offset-pagination-why-your-api-needs-an-upgrade-023c08d4614a)).
- **Effort:** M (touches each list page + UI "load more"/page controls) · **Deps:** matching sort indexes (#3).
- **Tier:** **Core.**

### 3. Index review for common query & sort paths
- **What it enables:** Keyset pagination and sorts use indexes instead of sorting/scanning within each org.
- **Design:** Add composite indexes that match `where` + `orderBy` together (Postgres can only use one index per scan, so the sort column must be in it):
  - `Deal @@index([orgId, status, createdAt])` (open-deals list filter + sort) and `@@index([orgId, stageId, createdAt])` for board columns.
  - `Contact @@index([orgId, lastName, firstName])` (list sort) — extends existing `[orgId, lastName]`.
  - `Activity @@index([orgId, completedAt, dueAt, createdAt])` to back the 3-key sort.
  - `Company` already `@@index([orgId, name])` — sufficient for its sort.
  - For ILIKE search (#7), add `pg_trgm` GIN indexes via a raw migration (Prisma can't express GIN trigram natively).
  Verify each with `EXPLAIN (ANALYZE, BUFFERS)` before/after.
- **Reference evidence:** Prisma query-optimization & best-practices guidance on composite indexes matching filter+sort and using `EXPLAIN` ([Prisma: Query optimization](https://www.prisma.io/docs/v6/orm/prisma-client/queries/query-optimization-performance), [Prisma: Best practices](https://www.prisma.io/docs/orm/more/best-practices)).
- **Effort:** S (schema indexes) + S (raw trigram migration) · **Deps:** migration via `DIRECT_URL` (#1).
- **Tier:** **Foundation.**

### 4. N+1 audit & Prisma `select`/`include` discipline
- **What it enables:** Less data over the wire, fewer round-trips, smaller serialized RSC payloads.
- **Design:** Replace blanket `include: { x: true }` with `select` of only displayed columns. E.g. deals list selects `contact: { select: { id, firstName, lastName } }, company: { select: { id, name } }` (drops `notes @db.Text` and timestamps). Detail pages already do this well for dropdowns — extend to the main entity. Keep using nested relational reads (Prisma batches them; the real risk is per-row `await` in loops, which the repo currently avoids). Add `@@map`-free `select` helpers shared across list/detail to enforce consistency. Audit target files: `deals/page.tsx`, `contacts/page.tsx`, `activities/page.tsx`, `contacts/export/route.ts`.
- **Reference evidence:** Prisma recommends `select` to fetch only needed fields and warns over-fetching/relation loading is a top performance cost; relation queries are batched, not per-row ([Prisma: Query optimization](https://www.prisma.io/docs/v6/orm/prisma-client/queries/query-optimization-performance), [Prisma: Best practices](https://www.prisma.io/docs/orm/more/best-practices)).
- **Effort:** S–M (mechanical edits across ~6 files) · **Deps:** none.
- **Tier:** **Core.**

### 5. Push aggregation into Postgres (dashboard)
- **What it enables:** Dashboard stays O(1) on data size instead of streaming all deals into Node.
- **Design:** Replace the three `findMany` + JS `reduce` in `dashboard/page.tsx` with `db.deal.groupBy({ by: ['stageId','status'], where: { orgId }, _sum: { value }, _count: true })` plus `db.deal.aggregate` for totals/win-rate. Compute per-stage chart values from the grouped result. This removes the largest unbounded transfer in the app.
- **Reference evidence:** Prisma aggregation/`groupBy` reference; query-optimization guidance to aggregate in the DB rather than in application code ([Prisma: Aggregation, grouping, summarizing](https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing), [Prisma: Query optimization](https://www.prisma.io/docs/v6/orm/prisma-client/queries/query-optimization-performance)).
- **Effort:** S (one page) · **Deps:** `[orgId, status]`/`[orgId, stageId,...]` indexes (#3).
- **Tier:** **Core.**

### 6. Application caching tiers (request → render → cross-request)
- **What it enables:** Avoid recomputing stable data on every request; cut DB hits for slowly-changing reads (pipeline stages, tags, org/membership, counts).
- **Design:** Three layers:
  1. **React `cache()`** — wrap per-request reads used by multiple components in one render (e.g. `requireOrg()`/membership lookup, repeated stage/tag fetches) to deduplicate within a single RSC pass. No TTL, no cross-request sharing.
  2. **Next.js Data Cache via `unstable_cache` (or `use cache` if `dynamicIO` is adopted)** — wrap slowly-changing, org-scoped reads (pipeline stages, tag list, dashboard aggregates) with explicit `tags: ["org:<id>:stages", ...]`. Requires removing blanket `force-dynamic` on those pages (or scoping it) so the cache is actually consulted.
  3. **Redis/Upstash (cross-request, multi-region)** — for state the Next data cache can't hold: rate limiting, sessions/short-lived tokens, and hot cross-request reads. Upstash is HTTP-based (no pooled TCP), ideal for serverless/edge.
- **Reference evidence:** `unstable_cache` caches ORM/db reads until `revalidateTag`/`revalidatePath`; React `cache` dedupes non-fetch data access per render; `use cache` is the unified Next 15+ primitive under `dynamicIO`; Upstash caches while the function is hot and avoids connection-pool/cold-start issues ([Next.js: unstable_cache](https://nextjs.org/docs/app/api-reference/functions/unstable_cache), [Next.js: use cache](https://nextjs.org/docs/app/api-reference/directives/use-cache), [Next.js caching explained](https://dev.to/cole_ruche/nextjs-caching-explained-every-strategy-you-need-to-know-react-cache-use-cache-cachetags--3hkl), [Upstash rate limiting at the edge](https://upstash.com/blog/edge-rate-limiting)).
- **Effort:** M (layers 1–2) · L if adopting Upstash + `dynamicIO` · **Deps:** Upstash account; lift `force-dynamic`.
- **Tier:** Layers 1–2 **Core**; Upstash layer **Strategic Bet.**

### 7. Search performance (Postgres trigram / FTS)
- **What it enables:** Fast substring/contact search within an org instead of sequential scans.
- **Design:** Enable `pg_trgm` and add GIN trigram indexes on `Contact(firstName/lastName/email)` (and company name) via a raw SQL migration, so `ILIKE '%q%'` is index-backed. For richer multi-word search, a `tsvector` generated column + GIN FTS index is the next step. Keep all search queries org-scoped (already the case in `search.ts`/`contacts/page.tsx`). Pair with debounced server-action search for the dropdown typeaheads from #2.
- **Reference evidence:** Cursor/offset and query-optimization guidance plus Postgres trigram practice for `ILIKE` (Prisma full-text/raw needed for GIN) ([Prisma: Query optimization](https://www.prisma.io/docs/v6/orm/prisma-client/queries/query-optimization-performance), [Prisma: Pagination](https://www.prisma.io/docs/orm/prisma-client/queries/pagination)).
- **Effort:** M (raw migration + verify plans) · **Deps:** `DIRECT_URL` migrations (#1); pairs with #3.
- **Tier:** **Strategic Bet.**

### 8. Org/entity-keyed cache invalidation strategy
- **What it enables:** Precise busting after writes — read-your-writes without globally dumping caches; correct in a multi-tenant app.
- **Design:** Standardize tag keys `org:<id>:<entity>` and (where needed) `org:<id>:<entity>:<recordId>`. On each server-action write, call `revalidateTag` for the affected tags instead of (or alongside) `revalidatePath`. Use `updateTag`/read-your-own-writes semantics for actions where the next read must be fresh (e.g. editing a contact then viewing it); `revalidateTag` (serve-stale-then-refresh) for list-level changes. Centralize key construction in one helper so tags stay consistent. Today's actions only `revalidatePath` broad routes (`contacts.ts`, `deals.ts`, etc.); migrate them as pages move off `force-dynamic` (#6).
- **Reference evidence:** `cacheTag` tags cached data for on-demand purge; `revalidateTag` vs `updateTag` (stale-while-revalidate vs read-your-writes) ([Next.js: cacheTag](https://nextjs.org/docs/app/api-reference/functions/cacheTag), [Next.js: revalidateTag](https://nextjs.org/docs/app/api-reference/functions/revalidateTag), [updateTag vs revalidateTag discussion](https://github.com/vercel/next.js/discussions/84805)).
- **Effort:** M (touches every action + a key helper) · **Deps:** caching tiers (#6).
- **Tier:** **Core.**

### 9. Observability: slow-query logging & DB metrics
- **What it enables:** See which queries/pages are slow before users do; data to drive indexing and N+1 work.
- **Design:** In `db.ts`, switch logging to event mode (`log: [{ emit: "event", level: "query" }]`) and add `db.$on("query", e => { if (e.duration > THRESHOLD) logger.warn(...) })` to capture slow queries with params/duration in production logs (Vercel log drains / Axiom). For aggregate latency percentiles, prefer **Prisma Accelerate/Optimize** dashboards or **OpenTelemetry** tracing — note the legacy Prisma `metrics` preview is deprecated (≤6.13.x) and slated for removal in v7, so don't build on it. Also enable Postgres `log_min_duration_statement` / `pg_stat_statements` at the DB for ground truth. (Caveat: adding a Prisma *client extension* can disable `$on` event logging — known issue — so keep the slow-query hook on the base client.)
- **Reference evidence:** Event-based logging with `$on("query")` exposes duration; metrics preview deprecated as of v6.14, OTel/native metrics recommended; extension+`$on` conflict ([Prisma: Logging](https://www.prisma.io/docs/orm/prisma-client/observability-and-logging/logging), [Prisma: performance metrics](https://www.prisma.io/docs/postgres/query-optimization/performance-metrics), [extension disables $on issue #23108](https://github.com/prisma/prisma/issues/23108)).
- **Effort:** S (logging hook) · M (OTel/Optimize wiring) · **Deps:** log sink (Axiom/Vercel) or Accelerate.
- **Tier:** **Foundation.**

---

## Scaling guidance (Prisma + Postgres on Vercel) — benchmarks/rules of thumb

- **Connection math:** effective max connections ≈ `concurrent warm lambdas × connection_limit`. With no pooler and Prisma's default pool (`num_cpus*2+1`), a modest traffic spike exhausts Postgres' ~100-connection default. With an external pooler + `connection_limit=1`, the pooler caps DB connections regardless of lambda count — this is the lever that lets tenant/traffic growth scale. ([Prisma: Database connections](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections), [Connection management](https://www.prisma.io/docs/guides/performance-and-optimization/connection-management).)
- **Cold starts:** plain `PrismaClient` adds bundle + engine cold-start cost; Accelerate (HTTP) or Prisma Postgres reduces it. Keep the singleton to amortize across warm calls.
- **List queries:** target keyset pagination + covering composite index → each page is an index range scan (sub-ms within org) instead of `take:200` truncation or full scans. Avoid offset for deep pages.
- **Aggregates:** never stream rows to Node to sum; `groupBy`/`aggregate` keeps dashboard latency flat as deal count grows.
- **Caching payoff:** stable org data (stages/tags/counts) cached with org-scoped tags removes the per-request DB hit that `force-dynamic` currently forces on every navigation.

---

## Top 3 picks

1. **Serverless connection management + `directUrl` (Capability 1)** — Foundation; without a pooler and a migration-safe direct URL, growth in tenants/traffic causes connection exhaustion and broken migrations. Highest risk, lowest effort.
2. **Cursor pagination + matching composite indexes (Capabilities 2 & 3)** — replaces silent `take:200`/unbounded `findMany` with constant-time, index-backed list loads — the core "stays fast as data grows" win.
3. **Caching tiers + org/entity-keyed invalidation + slow-query observability (Capabilities 6, 8, 9)** — lift blanket `force-dynamic`, cache slowly-changing org data with tag-based busting, and instrument slow queries so future optimization is data-driven.
