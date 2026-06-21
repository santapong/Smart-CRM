# Smart-CRM — Analytics, Attribution & Growth Instrumentation

**Lens:** Growth/marketing analytics (sales-funnel analytics, conversion by stage, deal velocity, lead-source & UTM attribution, marketing ROI, cohort analysis, A/B testing, product analytics for the CRM itself).
**Scope note:** The product team owns in-app reporting/dashboards. This doc focuses on **attribution + funnel/source/velocity analytics** and the **instrumentation** (data capture) required to make them possible. Where the two overlap (e.g. a funnel chart), the recommendation here is the *data layer + server-side aggregation*; visual polish coordinates with product.
**Date:** 2026-06-20 · **Author:** Marketing research

---

## Current-state assessment (read of the repo)

What exists today, and why it matters for this lens:

- **Schema (`prisma/schema.prisma`):** `Contact` and `Deal` have **no `source`/UTM fields** (confirmed lines 120–141, 185–210). Everything is `orgId`-scoped with good composite indexes (`@@index([orgId, status])`, `@@index([orgId, stageId])`). `Deal` has `value`, `status` (OPEN/WON/LOST), `stageId`, `closeDate`, `createdAt`, `updatedAt`. `PipelineStage` has an `order` field — essential for funnel ordering.
- **No stage-transition history.** `moveDealToStage` and `setDealStatus` in `src/server/actions/deals.ts` (lines 76–96) simply overwrite `stageId`/`status` with `db.deal.update(...)`. There is **no audit/event record**, so today it is *impossible* to compute time-in-stage, stage-to-stage conversion, or cohort progression from existing data. This is the single biggest instrumentation gap and a dependency for several ideas below.
- **Aggregation patterns already in use.** The dashboard (`src/app/(app)/dashboard/page.tsx`) does `Promise.all` of `findMany` + in-memory `reduce` for pipeline-by-stage. The companies page (`src/app/(app)/companies/page.tsx`) uses Prisma `_count`. So both "fetch + reduce" and Prisma aggregation idioms are established — new analytics can follow them, ideally upgrading hot paths to `groupBy`.
- **Server-action conventions.** All mutations: `"use server"` → Zod `safeParse` → `requireOrg()` (`src/lib/tenant.ts`) → `ActionResult` (`src/lib/action-result.ts`) → `revalidatePath`. New aggregation server actions / read functions should mirror this and always filter by `orgId`.
- **Charting:** recharts already wired (`src/app/(app)/dashboard/pipeline-chart.tsx`); Zod, date-fns, shadcn cards/table all available. `formatCurrency` exists in `src/lib/utils.ts`.
- **Data ingress points for capture:** contacts/deals are created via forms + server actions (`createContact`, `createDeal`); there is a public-ish CSV export route (`src/app/(app)/contacts/export/route.ts`) but **no public lead-capture endpoint** yet — so first-touch UTM capture needs a new ingestion path (web-to-lead) or has to be set at create time.

**Implication:** Smart-CRM can ship credible funnel/velocity/attribution analytics, but order matters. The two foundational enablers are (A) **source/UTM fields** and (B) a **stage-transition event log**. Most analytics ideas depend on one or both.

---

## Competitor landscape (evidence)

- **HubSpot** offers a full **Revenue Attribution** report builder (Reports → Analytics Tools → Revenue Attribution) with **7+ attribution models**: First interaction, Last interaction, Linear, U-shaped, W-shaped, Time decay, J-shape, Inverse-J, Full path. Concrete credit splits: **First/Last touch = 100%** to that single touch; **Linear = equal split**; **U-shaped = 40% first + 40% lead-conversion + 20% across the middle**; **W-shaped = 30%/30%/30%** to first / lead-creation / opportunity-creation with **10%** spread among the rest; **Time decay = 7-day half-life** (a touch 8 days out gets ~half the credit of one 1 day out). ([HubSpot multi-touch attribution](https://blog.hubspot.com/marketing/multi-touch-attribution), [HubSpot attribution report definitions](https://knowledge.hubspot.com/reports/understand-attribution-reporting), [First-touch](https://www.hubspot.com/glossary/first-touch-attribution), [Last-touch](https://www.hubspot.com/glossary/last-touch-attribution))
- **Pipedrive Insights** ships purpose-built report types this lens maps to directly: **Deal conversion / funnel** (conversion rate between consecutive pipeline stages, shown as a column/funnel chart), **Deal duration** (average time a deal spends in each stage / through the pipeline — the velocity report), **Deal progress** (advancement through stages over a time frame), **Won/Lost conversion** (win & loss rates grouped by owner, organization, time period), and **Revenue forecast**. **Goals** track Deal (Added/Progressed/Won), Activity, and Forecast targets; everything composes into **Dashboards**. ([Pipedrive Insights report types](https://support.pipedrive.com/en/article/insights-report-types), [Deal conversion](https://support.pipedrive.com/en/article/insights-reports-deal-conversion), [Deal duration](https://support.pipedrive.com/en/article/insights-reports-deal-duration), [Deal progress](https://support.pipedrive.com/en/article/insights-reports-deal-progress), [Insights goals](https://support.pipedrive.com/en/article/insights-goals), [Funnel analysis](https://www.pipedrive.com/en/features/sales-pipeline-analysis))
- **Lead-source / UTM capture pattern (industry standard):** forms include **hidden fields** that read `utm_*` from the landing URL and submit them to the CRM alongside lead data; for first-touch survival across page navigations, UTMs are stashed in a **first-party cookie** (often via GTM) and written into the hidden fields at submit. Known limitation: naive hidden-field capture reflects only the **last** touch and is lost on navigation unless cookie-backed. ([Ruler Analytics — UTMs to Salesforce](https://www.ruleranalytics.com/blog/crm/salesforce-utms/), [MeasureSchool — hidden form fields](https://measureschool.com/capture-utm-parameters-in-form-fields/), [SaaScend — lead-source best practices](https://www.saascend.com/best-practices-for-lead-source-tracking-capturing-utm-parameters-with-hidden-fields/), [Nutshell — CRM lead attribution](https://www.nutshell.com/marketing/lead-attribution))
- **What to measure per source (benchmarks):** leads, conversion-to-customer rate, revenue per source, cost effectiveness; inbound (content/SEO) typically converts **3–8%**, outbound (cold/direct) **1–3%**. Required components for reliable attribution: UTMs on all campaign URLs, consistent lead-source fields, and pipeline-stage mapping for sourced-vs-influenced. ([monday.com — lead analytics dashboard](https://monday.com/blog/crm-and-sales/lead-analytics-dashboard/), [growthgear — CRM analytics guide](https://marketing.growthgear.com.au/seo/crm-analytics-guide/))
- **Velocity & cohort framing:** time-in-stage is an early-warning signal that often **predicts outcomes better than pipeline volume**; cohort analysis groups opportunities by entry period to see whether one period's leads turn into the next period's pipeline; teams that analyze conversion by time period are **~1.5×** more likely to hit revenue targets. ([RevSure — pipeline metrics](https://www.revsure.ai/blog/mastering-pipeline-metrics-that-drive-saas-growth-a-strategic-guide-for-b2b-gtm-leaders), [monday.com — funnel analysis](https://monday.com/blog/crm-and-sales/what-is-sales-funnel-analysis/), [Monetizely — pipeline conversion rate](https://www.getmonetizely.com/articles/understanding-pipeline-conversion-rate-a-critical-metric-for-saas-success))

---

## Ideas

Effort legend: **S** ≈ ≤1–2 days, **M** ≈ ~3–5 days, **L** ≈ 1–2+ weeks. Tier: **Foundation** (unblocks others) / **Core** (high-value, expected of a CRM) / **Advanced** (differentiator).

---

### 1. Source & UTM capture fields on Contact + Deal  ⭐ FOUNDATION
**Desc.** Add lightweight lead-attribution fields. On **Contact** (the lead): `source` (enum-ish string: WEBSITE, REFERRAL, COLD_OUTREACH, EVENT, SOCIAL, PAID, OTHER), plus first-touch UTMs captured once and never overwritten: `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`, `landingPath`, `referrerUrl`, and `firstSeenAt`. On **Deal**, denormalize a `sourceContactId`/inherited `source` so revenue can be attributed even when a deal has multiple contacts. Keep all fields nullable so existing rows are valid.
**Competitor evidence.** Every attribution system starts from a stored source/UTM field; HubSpot's models all consume original-source + interaction data, and the standard capture pattern writes `utm_*` into CRM fields ([Ruler](https://www.ruleranalytics.com/blog/crm/salesforce-utms/), [SaaScend](https://www.saascend.com/best-practices-for-lead-source-tracking-capturing-utm-parameters-with-hidden-fields/)). Pipedrive/HubSpot both let you group nearly every report **by source**.
**Fit with Smart-CRM.** Pure additive Prisma migration on `Contact`/`Deal` (mirrors existing nullable fields like `Company.industry`). Extend `contactSchema`/`dealSchema` (Zod) and the create actions in `src/server/actions/{contacts,deals}.ts`; add an optional "Source" select to `contact-form.tsx`/`deal-form.tsx`. Add `@@index([orgId, source])` for fast source rollups. **First-touch immutability** enforced in the update action (only set UTMs if currently null).
**Effort.** **S–M.** Deps: none (this is the dependency for #4, #5, #6, #11).
**Tier.** Foundation.

---

### 2. Stage-transition event log (DealStageEvent)  ⭐ FOUNDATION
**Desc.** New table `DealStageEvent { id, orgId, dealId, fromStageId?, toStageId, fromStatus?, toStatus?, changedById?, createdAt }`. Append a row on every stage move and status change. This is the substrate for time-in-stage, funnel conversion, velocity, and cohorts — none of which are computable from the current schema because moves overwrite in place.
**Competitor evidence.** Pipedrive's **Deal duration** and **Deal progress** reports require exactly this kind of stage-history data ([Pipedrive duration](https://support.pipedrive.com/en/article/insights-reports-deal-duration), [progress](https://support.pipedrive.com/en/article/insights-reports-deal-progress)); time-in-stage is repeatedly cited as a top predictive metric ([RevSure](https://www.revsure.ai/blog/mastering-pipeline-metrics-that-drive-saas-growth-a-strategic-guide-for-b2b-gtm-leaders)).
**Fit with Smart-CRM.** Wrap the writes in `moveDealToStage` / `setDealStatus` / `updateDeal` (when `stageId` changes) in a `db.$transaction` that also inserts an event — minimal change to `src/server/actions/deals.ts`. Backfill a synthetic "created" event for existing deals (one-time script) so historical deals aren't invisible. Index `@@index([orgId, dealId])` and `@@index([orgId, createdAt])`.
**Effort.** **M.** Deps: none, but unblocks #3, #4, #7, #8.
**Tier.** Foundation.

---

### 3. Funnel & stage-conversion report  ⭐ CORE
**Desc.** A funnel view: count (and $ value) of deals that have *ever reached* each stage, with **stage-to-stage conversion %** between consecutive stages (e.g. Qualified→Proposal 62%), plus overall lead→won. Filterable by date range and (later) source/owner.
**Competitor evidence.** This is Pipedrive's **Deal conversion / funnel** report verbatim — "conversion rate between consecutive pipeline stages," rendered as a column/funnel chart ([Pipedrive deal conversion](https://support.pipedrive.com/en/article/insights-reports-deal-conversion), [funnel analysis](https://www.pipedrive.com/en/features/sales-pipeline-analysis)); stage conversion is "the earliest warning system in your pipeline" ([Monetizely](https://www.getmonetizely.com/articles/understanding-pipeline-conversion-rate-a-critical-metric-for-saas-success)).
**Fit with Smart-CRM.** A `getFunnel(orgId, range)` server-side read aggregating `DealStageEvent` "ever reached stage" sets, joined to ordered `PipelineStage`. Render with recharts (funnel/bar) reusing the `pipeline-chart.tsx` approach. *Approximation if #2 isn't shipped yet:* current-stage snapshot only (no historical reach) — note this limitation in UI.
**Effort.** **M.** Deps: #2 (full version); degraded version standalone.
**Tier.** Core.

---

### 4. Lead-source performance report (win rate & revenue by source)  ⭐ CORE
**Desc.** Table + chart: per `source` (and per `utmCampaign`), show leads created, deals created, win rate, won revenue, avg deal size, and lead→customer conversion %. The "where do our best customers come from" view.
**Competitor evidence.** Core lead-source reporting: track per channel total leads, conversion-to-customer rate, revenue per source ([monday.com](https://monday.com/blog/crm-and-sales/lead-analytics-dashboard/), [Nutshell](https://www.nutshell.com/marketing/lead-attribution)); inbound 3–8% vs outbound 1–3% benchmarks give users a yardstick ([growthgear](https://marketing.growthgear.com.au/seo/crm-analytics-guide/)).
**Fit with Smart-CRM.** `getSourcePerformance(orgId, range)` using Prisma `groupBy({ by: ['source'], _count, _sum: { value } })` over deals joined to contact source — directly extends the existing `groupBy`/`_count` idiom already on the companies page. New route `src/app/(app)/analytics/sources/page.tsx`.
**Effort.** **M.** Deps: #1.
**Tier.** Core.

---

### 5. First-touch vs last-touch attribution toggle  ⭐ CORE
**Desc.** When a deal/contact has multiple touch records, let the user switch revenue credit between **first-touch** (100% to original source) and **last-touch** (100% to most-recent source). Start single-touch (the field captured in #1 is first-touch); becomes multi-touch-capable once #11 lands.
**Competitor evidence.** First-touch = 100% to the first interaction (channel that creates awareness); last-touch = 100% to the last interaction before deal creation — HubSpot's two simplest models, and the right starting point ([HubSpot first-touch](https://www.hubspot.com/glossary/first-touch-attribution), [last-touch](https://www.hubspot.com/glossary/last-touch-attribution)).
**Fit with Smart-CRM.** With only #1's stored first-touch UTMs, "first-touch" is free; "last-touch" needs the touch log (#11). Implement as a `model: 'first' | 'last'` param on the source report's server action — a query branch, not new schema. Toggle is a shadcn `Select` on the analytics page.
**Effort.** **S** (first-touch only) / **M** (with last-touch). Deps: #1 (first), #11 (last).
**Tier.** Core.

---

### 6. Web-to-lead capture endpoint with auto-UTM tagging  ⭐ CORE
**Desc.** A public, org-scoped lead-intake API route (token in the URL) plus an optional embeddable JS snippet/hidden-field helper that reads `utm_*` + referrer from the landing page (first-party cookie for first-touch persistence) and POSTs a new Contact with attribution pre-filled. Turns Smart-CRM from "manually typed source" into automatic capture.
**Competitor evidence.** The canonical capture pattern: hidden form fields read `utm_*` from the URL and submit to the CRM; cookie-backed to survive navigation and preserve first-touch ([MeasureSchool](https://measureschool.com/capture-utm-parameters-in-form-fields/), [Ruler](https://www.ruleranalytics.com/blog/crm/salesforce-utms/), [SaaScend](https://www.saascend.com/best-practices-for-lead-source-tracking-capturing-utm-parameters-with-hidden-fields/)).
**Fit with Smart-CRM.** New `src/app/api/leads/[token]/route.ts` (mirrors the existing route-handler style in `contacts/export/route.ts`), Zod-validated, rate-limited, writing via a shared create-contact path. Needs a per-org ingest token (small addition to `Organization`). The snippet is static JS; honeypot + origin allowlist for spam.
**Effort.** **M–L.** Deps: #1 (fields to populate). Pairs with #11 for full touch history.
**Tier.** Core (high strategic value — closes the "no public lead-capture endpoint" gap).

---

### 7. Deal velocity / time-in-stage report  ⭐ CORE
**Desc.** Average (and median) time deals spend in each stage and end-to-end, plus a **stalled-deals** flag (open deals exceeding the stage's typical duration). Surfaces bottlenecks.
**Competitor evidence.** Pipedrive's **Deal duration** report — "average time it takes a deal to make it through your pipeline," to see "where your sales are slowing down" ([Pipedrive duration](https://support.pipedrive.com/en/article/insights-reports-deal-duration)); time-in-stage correlates with revenue predictability more than pipeline size ([RevSure](https://www.revsure.ai/blog/mastering-pipeline-metrics-that-drive-saas-growth-a-strategic-guide-for-b2b-gtm-leaders)).
**Fit with Smart-CRM.** Compute per-deal stage durations from consecutive `DealStageEvent` rows (`createdAt` deltas), aggregate to avg/median per stage. Server-side read; recharts bar of avg days per stage. Stalled flag reuses the same durations on the Kanban (`deals/kanban.tsx`).
**Effort.** **M.** Deps: #2.
**Tier.** Core.

---

### 8. Pipeline cohort analysis  ⭐ ADVANCED
**Desc.** Group deals/leads by **entry month** (created or first pipeline-entry) and track, per cohort, how many progressed / won / lost and cumulative won-revenue over subsequent months — a cohort retention-style grid for pipeline.
**Competitor evidence.** Cohort analysis groups opportunities by entry period to see "whether leads from one quarter turn into pipeline in the next"; analyzing conversion by time period correlates with ~1.5× higher likelihood of hitting targets ([monday.com funnel analysis](https://monday.com/blog/crm-and-sales/what-is-sales-funnel-analysis/), [Monetizely](https://www.getmonetizely.com/articles/understanding-pipeline-conversion-rate-a-critical-metric-for-saas-success)).
**Fit with Smart-CRM.** Bucket deals by `date_trunc('month', createdAt)` (or first `DealStageEvent`), cross with outcome/time. Heaviest aggregation here — recommend a raw SQL/`$queryRaw` cohort query rather than in-memory reduce. Render as a heatmap-style table (shadcn `Table` with color cells).
**Effort.** **L.** Deps: #2 (for progression cohorts); a simpler created→won cohort works on `Deal` alone.
**Tier.** Advanced.

---

### 9. Win/loss analysis with loss-reason capture  ⭐ CORE
**Desc.** Add an optional `lossReason` (enum: PRICE, COMPETITOR, NO_BUDGET, NO_DECISION, TIMING, OTHER) captured when a deal is set LOST; report win rate and loss-reason distribution, sliceable by source/owner/time.
**Competitor evidence.** Pipedrive's **Won/Lost conversion** report breaks win & loss rates by owner, organization, and time period ([Pipedrive report types](https://support.pipedrive.com/en/article/insights-report-types)); loss-reason is a standard qualitative attribution layer.
**Fit with Smart-CRM.** One nullable enum on `Deal`; capture in `setDealStatus` (currently a bare status write at `deals.ts:89`) — add an optional reason param + small dialog in `status-actions.tsx`. Report via `groupBy(['lossReason'])`. Cheap, high signal.
**Effort.** **S–M.** Deps: none (synergizes with #4/#5 for source-level loss patterns).
**Tier.** Core.

---

### 10. Product analytics / in-app event instrumentation for the CRM itself  ⭐ ADVANCED
**Desc.** Lightweight first-party event capture of *product usage* (feature adoption, activation, WAU/MAU per org) — distinct from sales analytics. Either a thin `UsageEvent` table or wiring a privacy-respecting analytics SDK (e.g. PostHog) behind a server boundary, to answer "are orgs activating and retaining?"
**Competitor evidence.** "Product analytics for the CRM itself" is explicitly in this lens's scope; growth teams instrument activation/retention to drive expansion. Source/funnel best-practice guides stress reviewing CRM usage and conversion metrics on a cadence ([monday.com](https://monday.com/blog/crm-and-sales/lead-analytics-dashboard/), [growthgear](https://marketing.growthgear.com.au/seo/crm-analytics-guide/)).
**Fit with Smart-CRM.** Server actions are the natural choke point to emit events (e.g. on `createDeal`, first invite, first import). Keep it org-scoped and opt-out-able. If self-hosting events, a `UsageEvent { orgId, userId?, name, props Json, createdAt }` table + nightly rollups; if external, gate behind an env flag (`src/env.ts` already centralizes config). **Privacy/multi-tenant care required** — never leak cross-org data.
**Effort.** **M** (self-hosted minimal) / **L** (full activation dashboards). Deps: none.
**Tier.** Advanced.

---

### 11. Multi-touch attribution touchpoint log + model selector  ⭐ ADVANCED
**Desc.** A `Touchpoint { id, orgId, contactId, channel, utm*, occurredAt }` table recording every marketing interaction (form fills, campaign clicks, manual logs, web-to-lead hits), then an attribution engine that distributes deal revenue across touches under a selectable model: **linear**, **U-shaped (40/40/20)**, **W-shaped (30/30/30/10)**, and **time-decay (7-day half-life)**.
**Competitor evidence.** Directly mirrors HubSpot's Revenue Attribution model set and exact credit splits — Linear (equal), U-shaped (40% first + 40% lead-conversion + 20% middle), W-shaped (30/30/30 + 10%), Time-decay (7-day half-life) ([HubSpot multi-touch attribution](https://blog.hubspot.com/marketing/multi-touch-attribution), [HubSpot attribution definitions](https://knowledge.hubspot.com/reports/understand-attribution-reporting)).
**Fit with Smart-CRM.** Builds on #1/#6: touches accumulate per contact; an attribution server action computes fractional credit per source per model and aggregates to a revenue-by-source-by-model report. Models are pure functions over an ordered touch list (well-suited to Vitest unit tests via the `qa-engineer` lane). This is the marquee growth feature but the heaviest; sequence it last.
**Effort.** **L.** Deps: #1, ideally #6 (to populate touches automatically).
**Tier.** Advanced.

---

### 12. UTM-tagged campaign link builder + lightweight A/B experiment tracking  ⭐ ADVANCED
**Desc.** Two coupled tools: (a) an in-app **UTM link builder** that generates consistent campaign URLs (guards against the messy/inconsistent UTMs that wreck attribution), and (b) a minimal **experiment** model tagging contacts/deals with a `variant` so conversion/win-rate can be compared across A/B variants of a campaign or landing page.
**Competitor evidence.** Consistent UTM tagging on all campaign URLs is a named prerequisite for reliable attribution ([growthgear](https://marketing.growthgear.com.au/seo/crm-analytics-guide/), [SaaScend](https://www.saascend.com/best-practices-for-lead-source-tracking-capturing-utm-parameters-with-hidden-fields/)); A/B testing is core growth instrumentation in this lens.
**Fit with Smart-CRM.** Link builder is a pure client component (no schema). Experiment tracking reuses the source/UTM fields from #1 (treat `utmContent`/a new `variant` field as the split) and the source-performance aggregation from #4 — compare conversion across variants. Keep statistics simple (rates + sample size; flag "not enough data").
**Effort.** **S** (link builder) / **M** (experiment tracking). Deps: #1, #4.
**Tier.** Advanced.

---

## Sequencing notes

- **Build order:** #1 + #2 first (both Foundation; everything else hangs off them) → #3, #4, #7, #9 (Core analytics, immediate value) → #5/#6 (capture + attribution toggle) → #8, #11, #12, #10 (Advanced differentiators).
- **Reuse, don't reinvent:** follow the `requireOrg()` + Zod + `ActionResult` server-action pattern; prefer Prisma `groupBy`/`_count` (as on the companies page) over in-memory reduce for the new aggregations; render with recharts as in `pipeline-chart.tsx`.
- **Guardrails to honor:** all reads/writes strictly `orgId`-scoped; first-touch fields immutable after first set; public capture endpoint (#6) needs spam protection + origin allowlist; product-analytics (#10) must never cross tenants.

---

## Top 3 picks

1. **Source & UTM capture fields on Contact + Deal (#1)** — the non-negotiable foundation. Tiny additive migration; unlocks lead-source reporting, first-touch attribution, and every downstream growth metric. Without stored source/UTM, nothing else in this lens is possible.
2. **Stage-transition event log → Funnel + Velocity reports (#2 → #3, #7)** — the second foundation plus its two highest-value payoffs. Today the schema literally can't compute conversion or time-in-stage (moves overwrite in place). One event table turns on Pipedrive-grade funnel-conversion and deal-duration analytics.
3. **Lead-source performance + first-touch/last-touch attribution (#4 + #5)** — the marketing-ROI headline: "which channels produce revenue, at what win rate," with a HubSpot-style attribution toggle. Directly answers the growth team's core question and is achievable on the #1 foundation with familiar `groupBy` aggregation.
