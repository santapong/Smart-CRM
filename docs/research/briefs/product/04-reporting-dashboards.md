# Smart-CRM Product Research — Reporting, Dashboards & Analytics

**Author:** Product research (Reporting/Dashboards/Analytics focus area)
**Date:** 2026-06-20
**Repo:** `/home/user/Smart-CRM`

---

## Context: where Smart-CRM is today

The current analytics surface is a single hardcoded dashboard at
`src/app/(app)/dashboard/page.tsx`:

- 4 fixed KPI stats (open pipeline value, won all-time value, win rate, contact·company counts), computed by pulling **all** open/won/lost deals into memory and `reduce()`-ing — `src/app/(app)/dashboard/page.tsx:30-33`.
- One recharts bar chart of pipeline value by stage (`src/app/(app)/dashboard/pipeline-chart.tsx`).
- An "Up next" list of 8 incomplete activities.
- No configuration, no date filters, no per-user/owner filters, no saved views, no export, no scheduling, no goals, no leaderboard.

**Patterns already in the repo I can build on:**

- Server actions: `"use server"` + Zod `safeParse` + `requireOrg()` tenant scoping + `ActionResult<T>` (`ok`/`fail`) return shape. See `src/server/actions/deals.ts`, `src/lib/action-result.ts`, `src/lib/tenant.ts`.
- RBAC ranking OWNER>ADMIN>MEMBER via `hasRole`/`requireRole` (`src/lib/rbac.ts`).
- CSV export already shipped as a route handler: `src/app/(app)/contacts/export/route.ts` + `src/lib/csv.ts` (`toCsv`). This is the reuse template for all report exports.
- recharts is the charting lib; shadcn/Radix for UI; `formatCurrency` in `src/lib/utils.ts`.
- Every domain row is `orgId`-scoped; `Deal` has `value/status/stageId/ownerId/companyId/contactId/closeDate/createdAt`; `Activity` has `type/dueAt/completedAt/ownerId`.

**The single most important data-model gap for analytics:** there is **no stage-transition history** on `Deal`. The schema (`prisma/schema.prisma:185-210`) stores only the *current* `stageId` and `updatedAt`. Funnel conversion rates, "time in stage," sales velocity, and any "deals that entered stage X this month" goal are impossible to compute accurately without an append-only event log. Capturing this is a foundational dependency (Idea 1) that unblocks Ideas 5, 6, and parts of 4 and 7. Competitors treat stage history as table stakes — Pipedrive's velocity/conversion reports "measure stage-by-stage conversion and average time spent in each stage" ([Pipedrive Insights](https://www.pipedrive.com/en/features/insights-and-reports)); Salesforce exposes Opportunity "Age" and field-history tracking ([Salesforce velocity](https://www.salesforce.com/blog/sales/sales-velocity/)).

A second cross-cutting note: KPI aggregation should move from "load all rows + JS reduce" to Prisma `aggregate`/`groupBy` so reports scale and stay tenant-cheap. This is implied work inside most ideas below.

---

## Idea 1 — Deal stage-history / event log (analytics foundation)

**(1) Name + desc.** A `DealStageEvent` (and optionally generic `DealEvent`) append-only table recording every stage move, status change (OPEN→WON/LOST), and value change, with `fromStageId/toStageId`, `enteredAt`, `userId`, `orgId`. Write events from the existing mutation paths (`moveDealToStage`, `setDealStatus`, `updateDeal` in `src/server/actions/deals.ts`). This is plumbing, not a user-facing screen, but it is the substrate for funnel, velocity, and time-in-stage reporting.

**(2) Competitor evidence.** Pipedrive conversion/velocity reports rely on stage-entry timestamps to compute "average time spent in each stage" ([Pipedrive Insights & Reports](https://www.pipedrive.com/en/features/insights-and-reports)). Salesforce surfaces Opportunity **Age** and uses field-history tracking to drive stage-movement and velocity reporting ([Salesforce: sales velocity](https://www.salesforce.com/blog/sales/sales-velocity/); [calculating velocity from opportunities](https://shaikhassadullah.medium.com/salesforce-reports-calculate-sales-velocity-from-opportunities-ad3a095e4f5c)). Pipedrive deal goals can even target "deals entering a specific pipeline stage," which is only measurable with stage-entry events ([Pipedrive goals](https://support.pipedrive.com/en/article/insights-goals)).

**(3) Fit with Smart-CRM.**
- **Models aggregated/added:** new `DealStageEvent { id, orgId, dealId, fromStageId?, toStageId, kind (STAGE_MOVE|STATUS_CHANGE|VALUE_CHANGE|CREATED), valueAtEvent?, createdAt, userId? }`; `@@index([orgId, dealId])`, `@@index([orgId, toStageId, createdAt])`. Relation off `Deal`.
- **New server actions / wiring:** no new public action — instrument existing `createDeal`/`updateDeal`/`moveDealToStage`/`setDealStatus` to emit events inside the same write (ideally a `db.$transaction`). Add a `recordDealEvent()` helper in `src/server/` or `src/lib/`. Optionally a one-time backfill script seeding a `CREATED` event per existing deal from `createdAt`.
- **UI:** none initially; later powers a "stage history" timeline on `src/app/(app)/deals/[id]/page.tsx`.

**(4) Effort: M.** Deps: schema migration; touch all four deal mutations; backfill. No UI. Pure backend (`backend-engineer`).

**(5) Tier: Free / foundational.** Ships invisibly under all tiers; the *reports* it powers can be tier-gated.

---

## Idea 2 — Funnel & conversion report

**(1) Name + desc.** A stage-funnel visualization: count and total value of deals at each pipeline stage, plus **stage-to-stage conversion %** and overall win rate, with a date range and owner filter. v1 ("snapshot funnel") works off current `stageId`; v2 ("flow funnel") uses Idea 1 events to show true progression and drop-off.

**(2) Competitor evidence.** Funnel is a first-class dashboard component in Zoho ("Funnels help to visualize different stages of your business process") ([Zoho analytical components](https://help.zoho.com/portal/en/kb/crm-help-old/analytics-and-dashboards/analytics-dashboards/overview/articles/old-analytical-components)). Pipedrive ships "conversion funnels … measure stage-by-stage conversion" ([Pipedrive Insights](https://www.pipedrive.com/en/features/insights-and-reports)). HubSpot offers funnel reports in its report builder.

**(3) Fit with Smart-CRM.**
- **Models aggregated:** `Deal` grouped by `stageId` (`db.deal.groupBy({ by: ['stageId'], _count, _sum: { value } })`), joined to `PipelineStage.order`; v2 adds `DealStageEvent`.
- **New server actions:** `getFunnelReport({ from, to, ownerId?, stageId? })` returning per-stage `{ stageName, order, count, value, conversionToNext }`.
- **UI:** new `/reports/funnel` page (new `src/app/(app)/reports/` route group), recharts funnel/horizontal-bar; reuse `formatCurrency`. Add a "Reports" nav entry in `src/components/app-sidebar.tsx`.

**(4) Effort: M.** Deps: v1 none; v2 depends on Idea 1. Frontend + one server action.

**(5) Tier: Free (snapshot v1) → Pro (flow/conversion v2).**

---

## Idea 3 — Goals & targets tracking

**(1) Name + desc.** Define recurring goals (revenue won, deals won count, activities completed, new deals created) scoped to a user / team / whole org, over weekly/monthly/quarterly intervals, and track attainment with progress bars + pace-to-goal. Surfaces on the dashboard and a dedicated `/reports/goals`.

**(2) Competitor evidence.** Pipedrive Goals: "track the number or value of deals … activities created or completed by type … revenue forecasts," "measured weekly, monthly, quarterly, or yearly," "assigned to specific users … Teams … or the entire company" ([Pipedrive goals](https://support.pipedrive.com/en/article/insights-goals); [activities & goals](https://www.pipedrive.com/en/features/activities-goals)). Zoho ships a **Target Meter** component to "set and track targets for your team" ([Zoho components](https://help.zoho.com/portal/en/kb/crm-help-old/analytics-and-dashboards/analytics-dashboards/overview/articles/old-analytical-components)).

**(3) Fit with Smart-CRM.**
- **Models added:** `Goal { id, orgId, name, metric (REVENUE_WON|DEALS_WON|DEALS_CREATED|ACTIVITIES_DONE), scopeType (USER|ORG), ownerId?, interval (WEEK|MONTH|QUARTER), target Decimal, startDate, createdAt }`. (Team scope deferred until a Team model exists — note this dependency.) `@@index([orgId])`.
- **Models aggregated for attainment:** `Deal` (`_sum value`/`_count` filtered by `status=WON` + `closeDate`/`updatedAt` in period), `Activity` (`_count` where `completedAt` in period, optionally by `type`), grouped by `ownerId`.
- **New server actions:** `createGoal/updateGoal/deleteGoal` (Zod + `requireOrg` + `requireRole(ADMIN)` to set others' goals); `getGoalProgress(goalId | period)` computing actual vs target + linear pace.
- **UI:** `/reports/goals` list with progress bars (shadcn `Progress`); a "Goals" card on the dashboard.

**(4) Effort: L.** Deps: schema migration; new actions; UI; interest from leaderboard (Idea 4) reuses the same per-owner aggregation. Team scope blocked on a future Team model.

**(5) Tier: Pro.**

---

## Idea 4 — Sales leaderboard

**(1) Name + desc.** A ranked table of org members by a selectable metric (won value, deals won, activities completed, new deals) over a chosen period, with medals for top performers and optional goal-attainment column (ties into Idea 3). Friendly competition + manager visibility.

**(2) Competitor evidence.** Pipedrive supports "competitions and rank scores in leaderboards" ([Pipedrive sharing/leaderboards](https://support.pipedrive.com/en/article/shareable-insights)); leaderboard dashboards are a staple of Pipedrive/Geckoboard setups ([Geckoboard for Pipedrive](https://www.geckoboard.com/product/data-sources/pipedrive/)). Zoho KPI components "measure the team's performance based on different parameters" ([Zoho components](https://help.zoho.com/portal/en/kb/crm-help-old/analytics-and-dashboards/analytics-dashboards/overview/articles/old-analytical-components)).

**(3) Fit with Smart-CRM.**
- **Models aggregated:** `Deal.groupBy({ by: ['ownerId'], _sum: { value }, _count })` filtered by status/period; `Activity.groupBy({ by: ['ownerId'] })`; join to `User.name` via `Membership` (org members). No schema change required.
- **New server actions:** `getLeaderboard({ metric, from, to })` returning `[{ userId, name, value, rank }]`.
- **UI:** `/reports/leaderboard` using shadcn `Table`; metric + period selectors; reuse `formatCurrency`.

**(4) Effort: S–M.** Deps: none (works on existing data); richer version reuses Idea 3 goal data. Mostly one server action + a table page.

**(5) Tier: Free (basic) → Pro (with goal attainment + team grouping).**

---

## Idea 5 — Sales velocity & time-in-stage report

**(1) Name + desc.** Compute pipeline velocity = (open opportunities × avg deal value × win rate) ÷ avg sales-cycle length, plus average **age** of open deals and **average time in each stage** to surface bottlenecks. Trend it over time.

**(2) Competitor evidence.** Standard formula `Sales Velocity = (Opportunities × Avg Deal Size × Win Rate) ÷ Sales Cycle Length` ([HubSpot velocity](https://blog.hubspot.com/sales/sales-velocity); [Pipedrive velocity](https://www.pipedrive.com/en/blog/sales-velocity); [Zoho velocity](https://www.zoho.com/crm/crm-express/whatissalesvelocity.html)). Salesforce exposes Opportunity **Age** and time-in-stage natively ([Salesforce velocity](https://www.salesforce.com/blog/sales/sales-velocity/)). Pipedrive velocity reports measure "average time spent in each stage" ([Pipedrive Insights](https://www.pipedrive.com/en/features/insights-and-reports)).

**(3) Fit with Smart-CRM.**
- **Models aggregated:** velocity inputs come from `Deal` aggregates (count OPEN, `_avg value`, win rate from WON/(WON+LOST), cycle length from `createdAt`→`closeDate` on won deals). **Time-in-stage requires Idea 1's `DealStageEvent`** (diff consecutive `enteredAt`s per deal/stage).
- **New server actions:** `getVelocityReport({ from, to, ownerId? })` → `{ velocity, avgDealValue, winRate, avgCycleDays, avgAgeOpenDays }`; `getTimeInStageReport()` → per-stage avg/median days.
- **UI:** `/reports/velocity` — KPI tiles + a per-stage horizontal bar of avg days.

**(4) Effort: M (velocity) / L (time-in-stage).** Deps: time-in-stage strictly needs Idea 1; velocity-only can ship on current data (cycle from createdAt→closeDate).

**(5) Tier: Pro.**

---

## Idea 6 — Activity report (effort & productivity)

**(1) Name + desc.** Reporting over `Activity`: volume completed vs overdue vs upcoming, broken down by type (TASK/CALL/MEETING/NOTE) and by owner, over a date range; trend line of activities/day; "overdue by rep" view. Answers "is the team doing the work?"

**(2) Competitor evidence.** Pipedrive Activity goals track "number of activities created or completed by activity type, like calls or meetings" ([Pipedrive activities & goals](https://www.pipedrive.com/en/features/activities-goals)). HubSpot's custom report builder includes activities and interaction "event" data as a reportable data source ([HubSpot custom report builder](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder)). Zoho ships activity/KPI dashboard components ([Zoho dashboards guide](https://www.glionconsulting.com/dashboards-in-zoho-crm/)).

**(3) Fit with Smart-CRM.**
- **Models aggregated:** `Activity.groupBy({ by: ['type'] | ['ownerId'] })` with `_count`; buckets via `completedAt` (done), `dueAt < now() && completedAt = null` (overdue), `dueAt >= now()` (upcoming). Existing indexes `@@index([orgId, dueAt])` / `@@index([orgId, completedAt])` already support these filters (`prisma/schema.prisma:238-239`).
- **New server actions:** `getActivityReport({ from, to, ownerId?, type? })`.
- **UI:** `/reports/activity` — stacked bar by type + per-owner table; recharts.

**(4) Effort: S–M.** Deps: none — schema and indexes already fit.

**(5) Tier: Free (basic) → Pro (per-owner breakdown).**

---

## Idea 7 — Configurable / custom dashboards (drag-and-drop widgets)

**(1) Name + desc.** Let users compose their own dashboards from a widget catalog (KPI tile, pipeline-by-stage, funnel, leaderboard, goal progress, activity chart, "deals closing this month" list), arrange them in a grid, save multiple named dashboards, set a default, and share with the org. Replaces the single hardcoded dashboard with saved, role-aware layouts.

**(2) Competitor evidence.** Pipedrive: "add custom reports to your dashboard by dragging a report from the Reports panel" and maintain multiple dashboards ([Pipedrive dashboards](https://support.pipedrive.com/en/article/insights-dashboards)). HubSpot dashboards support multiple reports, dashboard-level and per-report **filters** (date range, owner, pipeline), quick filters, and templates ([HubSpot customize dashboards](https://knowledge.hubspot.com/dashboards/customize-your-dashboards)). Zoho custom dashboards are "unlimited" with charts/KPI/funnel/target-meter/cohort components ([Zoho One plan](https://www.zoho.com/one/plan-details.html); [Zoho components](https://help.zoho.com/portal/en/kb/crm-help-old/analytics-and-dashboards/analytics-dashboards/overview/articles/old-analytical-components)).

**(3) Fit with Smart-CRM.**
- **Models added:** `Dashboard { id, orgId, name, ownerId, isShared, isDefault, createdAt }` and `DashboardWidget { id, dashboardId, type, config Json, x, y, w, h }` (grid coords + per-widget `config` JSON holding metric/filter). Reuse each report's server action as the widget data source.
- **New server actions:** `createDashboard/renameDashboard/deleteDashboard`, `upsertWidget/removeWidget/reorderWidgets`. All `requireOrg`-scoped; shared dashboards readable by org, editable by ADMIN+ or owner.
- **UI:** refactor `src/app/(app)/dashboard/page.tsx` into a renderer that reads a `Dashboard` + widgets and maps `type`→component; an "Add widget" picker; a grid layout (lightweight CSS grid first; `@dnd-kit` — already used by the Kanban — for drag-resize later). Dashboard-level date/owner filter bar.

**(4) Effort: L (largest).** Deps: most valuable once Ideas 2/4/6 widgets exist; `@dnd-kit` already in repo (deals Kanban) lowers drag-resize cost. Frontend-heavy + 2 new models.

**(5) Tier: Pro (custom dashboards) — keep one default dashboard Free.**

---

## Idea 8 — Saved report definitions + report builder (config-driven)

**(1) Name + desc.** A guided report builder: pick a primary object (Deal/Contact/Company/Activity), choose a measure (count / sum value / avg), a group-by dimension (stage, owner, status, company, tag, type, month), filters, and a viz (table/bar/line/pie). **Save** the definition as a named report users can re-open, clone, and pin to a dashboard. Start with a curated, validated field/dimension allowlist per object (config-driven) rather than arbitrary SQL.

**(2) Competitor evidence.** HubSpot's custom report builder is a 5-step flow — select data sources, select fields, filter, configure, save/export — over single-object and cross-object (up to 4 secondary sources) data ([HubSpot custom report builder](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder); [open beta announcement](https://community.hubspot.com/t5/Releases-and-Updates/Open-Beta-All-New-Custom-Report-Builder/ba-p/417825)). Salesforce report **formats** map directly to our viz choices: Tabular (table), Summary (group + subtotal + chart), Matrix (group by rows *and* columns) ([Salesforce report formats](https://www.phoneiq.co/blog/understanding-salesforce-report-formats-tabular-matrix-summary-and-joined)). Zoho offers "Custom Reports (Unlimited)" ([Zoho One plan](https://www.zoho.com/one/plan-details.html)).

**(3) Fit with Smart-CRM.**
- **Models added:** `ReportDefinition { id, orgId, name, object (DEAL|CONTACT|COMPANY|ACTIVITY), measure, groupBy, filters Json, viz, ownerId, isShared, createdAt }`.
- **New server actions:** `saveReport/updateReport/deleteReport/cloneReport`; a single `runReport(definitionId | draftDefinition)` executor that maps the (object, measure, groupBy, filters) tuple to a **whitelisted** Prisma `groupBy`/`aggregate` — never raw SQL — keeping it tenant-safe and Zod-validated. This executor is the engine the dashboard widgets (Idea 7) and exports (Idea 9) call.
- **UI:** `/reports` index (saved reports), `/reports/new` builder with object→measure→dimension→filter→viz steppers (shadcn `Select`/`Tabs`), recharts preview.

**(4) Effort: L.** Deps: the runner is the natural backbone for Ideas 7 and 9; keep v1 single-object (matches our model count) and defer cross-object joins. Big surface, but bounded by the allowlist approach.

**(5) Tier: Pro (build/save) → Enterprise (cross-object, more dimensions).**

---

## Idea 9 — Export & scheduled/emailed reports

**(1) Name + desc.** One-click **CSV/Excel export** of any report or saved definition, plus **scheduled delivery**: pick a report (or dashboard snapshot), cadence (daily/weekly/monthly) and recipients; the system renders and emails it. Builds directly on the existing CSV route pattern.

**(2) Competitor evidence.** Zoho supports scheduled reports (up to 100 schedules) ([Zoho One plan](https://www.zoho.com/one/plan-details.html)). Salesforce supports report/dashboard **subscriptions** on a schedule ([Salesforce reports & dashboards overview](https://www.apexhours.com/reports-in-salesforce/)). Pipedrive itself lacks native email scheduling (users reach for Geckoboard to "schedule snapshots … over email, Teams or Slack") — a concrete gap Smart-CRM can beat natively ([Pipedrive sharing](https://support.pipedrive.com/en/article/shareable-insights); [Geckoboard](https://www.geckoboard.com/product/data-sources/pipedrive/)).

**(3) Fit with Smart-CRM.**
- **Models added (for scheduling):** `ScheduledReport { id, orgId, reportDefinitionId?, dashboardId?, cadence, recipients String[], lastRunAt?, nextRunAt, createdAt }`.
- **Export reuse:** clone `src/app/(app)/contacts/export/route.ts` + `toCsv` (`src/lib/csv.ts`) into `/reports/[id]/export/route.ts`; CSV needs no new deps. XLSX needs a lib (e.g. `exceljs`).
- **Scheduling infra:** a cron-triggered route (`/api/cron/scheduled-reports`) — Vercel Cron fits the stack — that finds due `ScheduledReport`s, runs `runReport` (Idea 8) or renders a dashboard snapshot, and emails via an email provider (none configured yet — **new dependency**, e.g. Resend; note NextAuth email isn't currently wired). RBAC: only ADMIN+ can schedule org-wide sends.
- **UI:** "Export" buttons on every report; a "Schedules" tab under `/reports`.

**(4) Effort: CSV export S; scheduled email L.** Deps: scheduling needs cron + an email provider (infra add) and ideally Idea 8's `runReport`. CSV export alone is near-free given the existing route pattern.

**(5) Tier: CSV export Free → scheduled/emailed reports Pro/Enterprise.**

---

## Idea 10 — Dashboard filters & interactive drill-downs

**(1) Name + desc.** A dashboard-level filter bar (date range, owner, pipeline stage, status) that re-scopes every widget at once, plus **drill-downs**: clicking a chart segment (e.g. a stage bar, a leaderboard row, a funnel step) opens the underlying filtered list of deals/activities. Turns static charts into navigation.

**(2) Competitor evidence.** HubSpot dashboards support adjusting "data for a specific date range, specific owners or teams, or specific pipelines," filtering all reports or individual ones, with quick + advanced filters ([HubSpot customize dashboards](https://knowledge.hubspot.com/dashboards/customize-your-dashboards)). Drill-through from summary to detail is the core value of Salesforce Summary/Matrix reports ([Salesforce report formats](https://www.phoneiq.co/blog/understanding-salesforce-report-formats-tabular-matrix-summary-and-joined)). Zoho dashboards are explicitly interactive/drill-capable ([Zoho dashboards](https://www.zoho.com/analytics/dashboards.html)).

**(3) Fit with Smart-CRM.**
- **Models aggregated:** none new — filters become extra `where` clauses on the existing report server actions (`from/to/ownerId/stageId/status`). All already exist as `Deal`/`Activity` columns with indexes.
- **New server actions:** none new if report actions accept a shared `ReportFilters` Zod object; drill-down navigates to the existing list pages (`/deals`, `/activities`) with query-string filters (those pages would need to read filters — small lift).
- **UI:** a `ReportFilterBar` client component persisting filters in the URL (`useSearchParams`); chart `onClick` handlers (recharts supports cell/segment click) routing to filtered lists.

**(4) Effort: M.** Deps: most useful atop Ideas 2/4/7/8; list pages need to honor URL filters for drill-downs to land.

**(5) Tier: Free (basic date filter) → Pro (full filter bar + drill-downs).**

---

## Idea 11 — Forecast & "deals closing this period" report

**(1) Name + desc.** A revenue forecast view: open deals weighted by stage-based win probability (or simple expected = value × stage probability), bucketed by `closeDate` month/quarter, vs. committed (already-won) and vs. goal (Idea 3). Plus a plain "deals closing this month/quarter" actionable list.

**(2) Competitor evidence.** Pipedrive goals/insights include "Revenue Forecast: Track your expected revenue using deal probability and stage" and weighted open+won value ([Pipedrive goals](https://support.pipedrive.com/en/article/insights-goals); [Pipedrive Insights](https://www.pipedrive.com/en/features/insights-and-reports)). Forecasting is a headline Pipedrive/Dear Lucy dashboard ([Dear Lucy for Pipedrive](https://www.dearlucy.co/pipedrive)).

**(3) Fit with Smart-CRM.**
- **Models aggregated:** `Deal` where `status=OPEN` grouped by month(`closeDate`); needs a **probability per stage**. The schema has no probability field — add `PipelineStage.probability Int?` (0–100) (`prisma/schema.prisma:165-177`) or store a default mapping. Weighted value = `Σ value × probability/100`.
- **New server actions:** `getForecast({ from, to, ownerId? })` → per-period `{ committed, weightedOpen, bestCase }`.
- **UI:** `/reports/forecast` — stacked bar (committed vs weighted open) by month + a closing-this-period list (reuses deal row UI).

**(4) Effort: M.** Deps: small schema add (`PipelineStage.probability`); pairs naturally with goals (Idea 3).

**(5) Tier: Pro.**

---

## Idea 12 — Snapshot/trend history (KPIs over time) + anomaly flags

**(1) Name + desc.** Persist a daily snapshot of headline metrics per org (open pipeline value, won MTD, deal count, win rate, activities done) so the product can render **trend lines** ("pipeline up 12% vs last month") and flag **anomalies** (e.g., new-deal creation drops sharply). Today everything is point-in-time; there is no history to trend.

**(2) Competitor evidence.** Zoho ships an **Anomaly Detector** that "identifies discrepancies in your usual business processes" and **Cohort** analysis "over time" ([Zoho components](https://help.zoho.com/portal/en/kb/crm-help-old/analytics-and-dashboards/analytics-dashboards/overview/articles/old-analytical-components)). HubSpot/Pipedrive dashboards lean heavily on period-over-period trend deltas ([HubSpot sales reporting](https://www.pixcell.io/blog/hubspot-sales-reporting-best-dashboards)).

**(3) Fit with Smart-CRM.**
- **Models added:** `MetricSnapshot { id, orgId, date, openPipelineValue, wonValueMtd, dealCount, winRate, activitiesDone }`, unique `@@unique([orgId, date])`.
- **New server actions / infra:** a daily cron route (`/api/cron/snapshots`, Vercel Cron) computing snapshots via Prisma aggregates; `getTrend(metric, range)` reader. Anomaly = simple z-score / % deviation vs trailing average (no ML needed for v1).
- **UI:** sparkline/delta badges on dashboard KPI tiles; a "Trends" widget for Idea 7.

**(4) Effort: M.** Deps: cron infra (shared with Idea 9). Independent of stage-history (Idea 1). Anomaly detection is an incremental add on top of the snapshot table.

**(5) Tier: Pro (trends) → Enterprise (anomaly alerts).**

---

## Cross-cutting dependencies (summary)

| Foundational item | Unblocks |
|---|---|
| **Idea 1** DealStageEvent log | Funnel flow (2 v2), Velocity time-in-stage (5), stage-entry goals (3) |
| **Idea 8** `runReport` executor (whitelisted groupBy) | Custom dashboards widgets (7), Export/scheduled (9) |
| **Cron infra** (Vercel Cron) | Scheduled reports (9), Metric snapshots/trends (12) |
| **Email provider** (e.g. Resend — not yet configured) | Scheduled/emailed reports (9), anomaly alerts (12) |
| **Move aggregation to Prisma `groupBy`/`aggregate`** | Every report (replaces current "load all rows + JS reduce" in `dashboard/page.tsx`) |
| **Team model** (does not exist) | Team-scoped goals (3) and team leaderboard grouping (4) |

---

## Top 3 picks

1. **Idea 1 — Deal stage-history / event log (M, foundational).** Highest leverage: it's the prerequisite for funnel-flow, velocity/time-in-stage, and stage-entry goals — the analytics that actually differentiate a CRM. Cheap to add now (instrument 4 existing deal mutations); painful to retrofit later because history can't be reconstructed. Do this first.

2. **Idea 3 — Goals & targets tracking (L, Pro).** The biggest *visible* gap vs Pipedrive/Zoho and a clear monetizable Pro feature; reuses per-owner Deal/Activity aggregation that also powers the leaderboard (Idea 4), giving two features for close to one backend's effort.

3. **Idea 7 — Configurable custom dashboards (L, Pro).** The flagship platform capability that reframes Smart-CRM from "a fixed dashboard" to "a reporting platform," directly matching HubSpot/Pipedrive/Zoho. Sequence it after a few widget-producing reports (2/4/6) exist, and lean on the repo's existing `@dnd-kit` (Kanban) to keep drag-resize cheap.

*Fast-follow / quick wins to interleave:* **Idea 4 (Leaderboard, S–M)** and **Idea 6 (Activity report, S–M)** ship on existing data with no migration, and **Idea 9's CSV export (S)** is near-free given `contacts/export/route.ts`.
