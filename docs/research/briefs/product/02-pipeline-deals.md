# Smart-CRM Product Research — Sales Pipeline & Deal Management

**Focus area:** Multiple pipelines, weighted pipeline & forecasting, products/line items & catalog, quotes/proposals, quotas & targets, rotting/stale-deal indicators, deal-stage automation UX, win/loss reasons.
**Author:** Product research (pipeline & deals)
**Date:** 2026-06-20

---

## Current state of Smart-CRM (grounding)

Read from the repo:

- **Data model** (`prisma/schema.prisma`): `Deal { title, value Decimal(12,2), currency, status OPEN/WON/LOST, stageId→PipelineStage, companyId, contactId, ownerId, closeDate, notes, createdAt, updatedAt }`. `PipelineStage { name, order, color }` with `@@unique([orgId, name])` — **exactly one set of stages per org**. Every table has `orgId`.
- **Server actions** (`src/server/actions/deals.ts`): `createDeal`, `updateDeal`, `moveDealToStage(id, stageId)`, `setDealStatus(id, OPEN|WON|LOST)`, `deleteDeal`. All scope via `requireOrg()` from `src/lib/tenant.ts`; RBAC helper in `src/lib/rbac.ts` (`requireRole`, ranks MEMBER<ADMIN<OWNER) is available but **not yet applied** to deal actions.
- **UI** (`src/app/(app)/deals/*`): `page.tsx` loads `status: "OPEN"` deals + stages and renders `kanban.tsx` (one @dnd-kit board, columns sum `value` per stage). `[id]/page.tsx` + `deal-form.tsx` for edit; `[id]/status-actions.tsx` for Won/Lost. New-deal at `new/page.tsx`.
- **Dashboard** (`src/app/(app)/dashboard/page.tsx`): open-pipeline sum, won total, win rate = won/(won+lost), a `pipeline-chart.tsx` (recharts) of **raw** value by stage. No weighting, no forecast, no time series.
- **Stages seeded** identically in `prisma/seed.ts` and `signUpAction` (`src/server/actions/auth.ts`): Lead → Qualified → Proposal → Negotiation → Closing. The `DEFAULT_STAGES` literal is duplicated in both files.
- **Activity model** exists and links `dealId` — useful raw material for "rotting" (last-activity) and stage-history once we add events. `src/lib/csv.ts` has a `toCsv` helper (export already a pattern).

**Confirmed gaps (grep):** no `probability|weighted|forecast|quota|rotting|stale` anywhere; no products/line-items/quotes models; `Deal` has no `pipelineId`, no probability, no won/loss reason, no stage-entry timestamp.

These gaps map cleanly onto the proposals below. Two foundational items (multiple pipelines; probability/weighting) unlock most of the rest, so they are sequenced first.

---

## Ideas

### 1. Multiple pipelines (per-org, with per-pipeline stages)
**Description:** Let an org run several independent pipelines (e.g. "New Business", "Renewals", "Partnerships"), each with its own ordered stages. A Deal belongs to exactly one pipeline; the Kanban shows a pipeline switcher.

**Competitor evidence:** *Pipedrive* — "A pipeline represents a sales process… create separate pipelines for different sales processes." Stages are owned by a pipeline. *HubSpot* sets stage probability per pipeline (`CRM > Deals > Add pipeline automation`). *Zoho/Salesforce* support multiple sales processes. This is table-stakes for every pipeline-centric competitor.

**Fit with Smart-CRM today:**
- Schema: new `Pipeline { id, orgId, name, order, isDefault }`; add `pipelineId` to `PipelineStage` and to `Deal`; change stage uniqueness from `@@unique([orgId, name])` to `@@unique([pipelineId, name])`. Backfill: create one "Default" pipeline per org, attach existing stages + deals.
- Actions: extend `createDeal`/`updateDeal` to require/carry `pipelineId`; `moveDealToStage` must verify the target stage belongs to the same pipeline (today it only checks `orgId`). Add `createPipeline`/`renamePipeline`/`reorderPipeline`/`archivePipeline` (gate with `requireRole(role, "ADMIN")`).
- UI: pipeline `<Select>` in the Deals `PageHeader` (`src/app/(app)/deals/page.tsx`); `page.tsx` query filters `where: { orgId, pipelineId, status: "OPEN" }`; `kanban.tsx` largely unchanged. De-duplicate `DEFAULT_STAGES` (currently in `auth.ts` + `seed.ts`) into a shared constant when seeding the default pipeline.

**Effort:** **M** (migration + backfill is the bulk; UI is small). **Dependencies:** none — this is the foundation for #2, #3, #6, #9.

**Priority:** **Core**

---

### 2. Stage probability + weighted pipeline value
**Description:** Each stage carries a default win-probability (0–100%); each deal inherits it but can override. Surface **weighted value = value × probability** on cards, columns, and the dashboard.

**Competitor evidence:** *HubSpot* — "multiply the deal amounts at each pipeline stage by the probability… a $100 deal with a 60% probability is counted as $60." *Pipedrive* — "set a stage probability to estimate how likely deals in that stage are to close… or enable deal probability" per deal (deal-level overrides stage-level). Universal across HubSpot/Pipedrive/Salesforce/Zoho.

**Fit with Smart-CRM today:**
- Schema: add `probability Int?` to `PipelineStage` (stage default) and `probability Int?` to `Deal` (override; null = inherit stage). Optionally auto-set 100/0 when status WON/LOST.
- Actions: `updateDeal` accepts optional `probability` (Zod `z.coerce.number().int().min(0).max(100).optional()`); a small `effectiveProbability(deal, stage)` helper in `src/lib/` for reuse server-side.
- UI: show weighted figure on `DealCard` and as a second number in each `StageColumn` header in `kanban.tsx` (already computes raw `totals` — add a weighted reducer). Probability input on `deal-form.tsx`. Dashboard `pipeline-chart.tsx` gains a weighted series.

**Effort:** **S–M**. **Dependencies:** strongest paired with #1 (probabilities live on per-pipeline stages); standalone-viable on the single pipeline.

**Priority:** **Core**

---

### 3. Revenue forecast view (close-date columns) + weighted forecast report
**Description:** A second board view that buckets open deals by **expected close month/quarter**, each column summing committed (won) + open + weighted-projected revenue. Drag a card between months to update `closeDate`.

**Competitor evidence:** *Pipedrive* "deal forecast view" — "a kanban view of deals separated into date-based columns… summary of projected revenue based on the expected close date… drag-and-drop to update the deal's expected close date." *HubSpot* forecast = "deal value, projected close date, and probability… rolled up by rep, team, or pipeline."

**Fit with Smart-CRM today:**
- Schema: reuses `Deal.closeDate` + probability from #2; no new tables for v1.
- Actions: add `setDealCloseDate(id, date)` (mirror of `moveDealToStage`, `revalidatePath("/deals")`).
- UI: new route `src/app/(app)/deals/forecast/page.tsx` reusing the @dnd-kit scaffolding from `kanban.tsx` but columns keyed by `closeDate` month buckets. A tab toggle (Board | Forecast) in the Deals header. Dashboard can add a "weighted forecast this quarter" stat next to the existing win-rate `Stat`.

**Effort:** **M**. **Dependencies:** #2 (probability) for the weighted projection; #1 to scope the forecast per pipeline.

**Priority:** **Core**

---

### 4. Rotting / stale-deal indicators (per-stage idle threshold)
**Description:** Flag deals untouched for longer than a configurable number of days; render them with a visual "rotting" warning on the board and offer a "Rotting" filter. Threshold configurable per stage.

**Competitor evidence:** *Pipedrive* Rotting feature — "visually notify you of any deals you haven't updated for longer than the defined rotting period," shown with **red shading**, and "customise the number of days… on a per-stage basis." A signature Pipedrive differentiator (no direct equivalent in base HubSpot).

**Fit with Smart-CRM today:**
- Schema: add `rottingDays Int?` to `PipelineStage`. "Last touched" can start from existing `Deal.updatedAt`; for fidelity, later track `lastActivityAt` (max of related `Activity` + stage moves — see #8/#5). Per-org default could live on `Organization`.
- Actions: pure helper `isRotting(deal, stage, now)` in `src/lib/` (also Vitest-friendly — repo already has `tests/unit/`). No write needed for the indicator; moving/editing a deal already bumps `updatedAt`.
- UI: in `kanban.tsx`, add a red ring / "🕒 N days idle" badge to `DealCard` when rotting; a header toggle to filter rotting only. Stage settings screen exposes `rottingDays`.

**Effort:** **S** (indicator on `updatedAt`); **M** if adding true `lastActivityAt`. **Dependencies:** none for v1; richer with #5/#8.

**Priority:** **Quick Win**

---

### 5. Required win/loss reasons on close (configurable lists + reporting)
**Description:** When a deal is set WON or LOST, prompt for a reason from an org-configurable list (e.g. Lost: Price, Competitor, No budget, Timing). Make it required for LOST. Report on reasons.

**Competitor evidence:** *Pipedrive* — marking a deal lost "prompts for a reason," up to 100 lost reasons, predefined or freeform, reportable in Insights (Deal > Performance). *HubSpot* — closed-lost reason can be made a required drop-down via deal automation; long-standing top community request. Pipedrive's auto-prompt-on-close is the UX to copy.

**Fit with Smart-CRM today:**
- Schema: `CloseReason { id, orgId, kind WON|LOST, label, order, archived }`; add `closeReasonId String?` + `closeReasonNote String?` to `Deal`. (Reuse the existing `DealStatus` enum for `kind`.)
- Actions: change `setDealStatus(id, status, reasonId?)` — when status is LOST, require a valid org-scoped reason; record it. Add `createCloseReason`/`reorder`/`archive` (ADMIN-gated). Note: `setDealStatus` currently uses `updateMany`; switch to a `findFirst` + `update` so we can validate the reason against the org.
- UI: replace the plain Won/Lost buttons in `[id]/status-actions.tsx` with a small dialog that shows the reason `<Select>` on Lost (and optionally Won). Add a "win/loss reasons" section to settings. New dashboard card: lost reasons breakdown (recharts).

**Effort:** **M**. **Dependencies:** none. Pairs naturally with #10 (analytics).

**Priority:** **Quick Win** (high signal, low schema cost)

---

### 6. Products / line-items catalog (deal value rolls up from items)
**Description:** An org product catalog (SKU, name, default price, currency); deals get line items (product, qty, unit price, discount). Deal `value` becomes the sum of line items.

**Competitor evidence:** *Pipedrive* Products — "create a catalog of the products or services you sell," linked to deals as line items where **Amount = price × Quantity**; supports percentage **and** monetary discounts, and tax inclusive/exclusive/none. *HubSpot* and *Zoho* have equivalent products + line items. Foundational for quotes (#7) and product-level forecasting.

**Fit with Smart-CRM today:**
- Schema: `Product { id, orgId, name, sku?, unitPrice Decimal, currency, active }`; `DealLineItem { id, dealId, productId?, name, quantity, unitPrice Decimal, discountPct?, discountAmt? }`. Keep `Deal.value` as a denormalized cached sum (recompute on line-item change) so existing Kanban/dashboard sums keep working unchanged.
- Actions: new `src/server/actions/products.ts` (CRUD) and `addLineItem`/`updateLineItem`/`removeLineItem` in `deals.ts` that recompute and persist `Deal.value` in a transaction. `formatCurrency` (`src/lib/utils.ts`) already handles display.
- UI: line-items editor table on `[id]/page.tsx` / `deal-form.tsx`; a `/settings/products` (or `/products`) catalog screen. `DealCard` can show item count.

**Effort:** **L**. **Dependencies:** none strictly, but is the base for #7 and #11.

**Priority:** **Strategic Bet**

---

### 7. Quotes / proposals (generate a shareable doc from line items)
**Description:** Generate a branded quote from a deal's line items with totals/discount/tax, a public read-only link, accept/expire states, and PDF/print. Accepting can auto-advance the deal stage.

**Competitor evidence:** *Pipedrive* Smart Docs — "generate quote documents… template with product placeholders… products linked to the deal added automatically." Ecosystem apps (PandaDoc, QuoteWerks, Extraflow) two-way-sync line items, statuses, and signed PDFs. *HubSpot* has native Quotes with e-sign. Clear market expectation once products (#6) exist.

**Fit with Smart-CRM today:**
- Schema: `Quote { id, orgId, dealId, number, status DRAFT/SENT/ACCEPTED/DECLINED/EXPIRED, publicToken, expiresAt, subtotal, discountTotal, taxTotal, total, currency, createdAt }` + `QuoteLineItem` snapshot (so a sent quote is immutable even if the catalog changes).
- Actions: `createQuoteFromDeal(dealId)` (copies current line items), `sendQuote`, `markQuoteAccepted` (optionally calls `moveDealToStage`/`setDealStatus`). Public accept route is unauthenticated but token-scoped — must **not** use `requireOrg()`; look up strictly by `publicToken`.
- UI: "Create quote" on the deal page; quote builder; a public route `src/app/(public)/q/[token]/page.tsx` (outside the `(app)` auth group). Print-to-PDF via the browser for v1 (no new dep); server-side PDF later.

**Effort:** **L**. **Dependencies:** **#6 (products/line items)** is a hard prerequisite.

**Priority:** **Strategic Bet**

---

### 8. Stage-change history + stage-automation UX (auto-create follow-up; required fields to advance)
**Description:** Record every stage transition with timestamp; use it to power "time in stage" and lightweight automations: moving a deal into a stage can require fields (e.g. closeDate before "Negotiation") and/or auto-create a follow-up Activity.

**Competitor evidence:** *Pipedrive* automations = trigger ("Deal stage changed") + action ("create a follow-up activity"); conditions can require specific fields. Example from docs: logging "Interested" "automatically moves the deal to Demo Scheduled and creates a follow-up activity three days out." *HubSpot* deal-stage automation does the same plus required properties.

**Fit with Smart-CRM today:**
- Schema: `DealStageEvent { id, dealId, fromStageId?, toStageId, movedById?, createdAt }`. Optionally `PipelineStage.requiredFields String[]` and a tiny `StageAutomation` rule table for "create activity on enter."
- Actions: have `moveDealToStage` (and stage changes via `updateDeal`) write a `DealStageEvent`, enforce required fields (return `fail()` with field errors — matches existing `ActionResult` shape), and optionally insert an `Activity` (model already supports `dealId`, `dueAt`). This also feeds accurate `lastActivityAt` for #4 and time-in-stage for #10.
- UI: timeline on `[id]/page.tsx` (next to the existing Activity aside); inline error/toast in `kanban.tsx` when a move is blocked (the board already rolls back optimistic moves on `!r.ok`).

**Effort:** **M** (events + required-fields); **L** if a full rules builder. **Dependencies:** light; amplifies #4 and #10.

**Priority:** **Core**

---

### 9. Quotas & targets (per-rep / per-pipeline, with attainment tracking)
**Description:** Set revenue (and/or deal-count) quotas per user per period (month/quarter), then track attainment = won value vs quota, with a leaderboard and pacing.

**Competitor evidence:** *Salesforce* — admins "set sales quotas for each user." *Zoho* — top-down and bottom-up forecasting with per-user quotas rolling up; real-time "Target Meters" / forecast dashboard of closed vs goal. *HubSpot* forecasting sets "goals for each user for the selected time period."

**Fit with Smart-CRM today:**
- Schema: `Quota { id, orgId, userId, pipelineId?, period (month start date), amount Decimal, dealCount Int? }` with `@@unique([orgId, userId, pipelineId, period])`.
- Actions: new `src/server/actions/quotas.ts` — `setQuota` (ADMIN-gated). Attainment computed by summing WON `Deal.value` for the user in the period (deals already carry `ownerId`, `closeDate`/`updatedAt`).
- UI: `/settings/quotas` grid (members × periods) reusing membership data already loaded in settings; attainment widgets on the dashboard (recharts gauge/bar). The existing `User ↔ ownedDeals` relation makes per-rep rollups straightforward.

**Effort:** **M**. **Dependencies:** WON-tracking exists today; per-pipeline quotas need #1; sharper with #2/#3 (pacing vs weighted pipeline).

**Priority:** **Strategic Bet**

---

### 10. Pipeline analytics: conversion funnel, win rate by stage, sales velocity, time-in-stage
**Description:** A reporting view: stage-to-stage conversion funnel, win rate per stage, average time in stage, average sales cycle, and sales velocity (≈ open deals × win rate × avg value ÷ cycle length).

**Competitor evidence:** *Pipedrive* Insights and *HubSpot* pipeline reports surface conversion, win rate, and velocity; *Zoho* sales analytics covers the same metric set. Standard sales-ops reporting expected at this tier.

**Fit with Smart-CRM today:**
- Schema: best powered by `DealStageEvent` (#8) for time-in-stage and true conversion; a v1 can approximate from `Deal.status` + `createdAt/updatedAt` without it.
- Actions: read-only aggregations (`db.deal.groupBy` / raw SQL) in a server component; CSV export via existing `toCsv` (`src/lib/csv.ts`).
- UI: new `src/app/(app)/deals/insights/page.tsx` (or extend dashboard) with recharts funnel/bars — the app already uses recharts in `dashboard/pipeline-chart.tsx`.

**Effort:** **M** (S for an approximate v1). **Dependencies:** richest with #8; basic version standalone.

**Priority:** **Core**

---

### 11. Recurring products / MRR-ARR on deals
**Description:** Mark catalog products as recurring (monthly/annual) so deals expose one-time vs recurring value and compute MRR/ARR/ACV alongside the headline `value`.

**Competitor evidence:** *Pipedrive* recurring products/subscriptions — "configure products as Subscriptions with different billing frequencies," computing **ACV, MRR, ARR**; for infinite-cycle recurring, MRR/ARR assume a 12-month term. Essential for SaaS sellers; differentiates from a purely one-time-deal CRM.

**Fit with Smart-CRM today:**
- Schema: extend #6's `Product`/`DealLineItem` with `billingFrequency ONE_TIME|MONTHLY|ANNUAL` and derive MRR/ARR; optionally cache `Deal.mrr`/`Deal.arr`.
- Actions: extend line-item recompute (#6) to also roll up MRR/ARR.
- UI: recurring toggle in the catalog; MRR/ARR shown on the deal page and as dashboard stats (sits beside the existing open-pipeline/won `Stat`s).

**Effort:** **M** (on top of #6). **Dependencies:** **#6** required. Strong combined with #9 (recurring quota) and #3 (recurring forecast).

**Priority:** **Strategic Bet**

---

### 12. Bulk pipeline actions + saved filters/views on the board
**Description:** Multi-select deals on the Kanban for bulk move-stage / change-owner / mark won-lost / delete, plus saved filter views (owner, value range, rotting, close-date window).

**Competitor evidence:** *Pipedrive* pipeline view supports filters and bulk edits; *HubSpot* board has bulk actions and saved views; *Zoho* list/Kanban filters likewise. A productivity baseline once deal volume grows.

**Fit with Smart-CRM today:**
- Schema: optional `SavedView { id, orgId, userId?, name, pipelineId?, filterJson }` for persisted filters; bulk actions need no schema.
- Actions: `bulkMoveDeals(ids[], stageId)`, `bulkSetStatus(ids[], status)`, `bulkAssign(ids[], ownerId)` — all `requireOrg`-scoped `updateMany`. Reasonable place to start applying `requireRole` to destructive ops (delete currently has no role check).
- UI: selection state + a bulk action bar in `kanban.tsx` (already client-side with optimistic updates); filter controls in the Deals header.

**Effort:** **M** (S for bulk-only without saved views). **Dependencies:** filters by rotting/probability use #2/#4; works standalone otherwise.

**Priority:** **Quick Win**

---

## Effort & priority matrix

| # | Feature | Effort | Tier | Key dependency |
|---|---------|--------|------|----------------|
| 1 | Multiple pipelines | M | Core | — (foundation) |
| 2 | Stage probability + weighted value | S–M | Core | best with #1 |
| 3 | Revenue forecast (close-date) view | M | Core | #2 |
| 4 | Rotting / stale-deal indicators | S | Quick Win | — |
| 5 | Required win/loss reasons | M | Quick Win | — |
| 6 | Products / line-items catalog | L | Strategic Bet | — |
| 7 | Quotes / proposals | L | Strategic Bet | #6 |
| 8 | Stage history + automation UX | M | Core | — |
| 9 | Quotas & targets | M | Strategic Bet | #1 |
| 10 | Pipeline analytics (funnel/velocity) | M | Core | best with #8 |
| 11 | Recurring products / MRR-ARR | M | Strategic Bet | #6 |
| 12 | Bulk actions + saved views | M | Quick Win | — |

---

## Top 3 picks

1. **Multiple pipelines (#1)** — the single highest-leverage gap vs every competitor and the prerequisite that unlocks per-pipeline probability, forecasting, and quotas. Effort M, mostly a migration + backfill; UI is a header `<Select>` plus a same-pipeline guard in `moveDealToStage`.

2. **Stage probability + weighted pipeline value, leading into the forecast view (#2 → #3)** — turns Smart-CRM from a task board into a revenue tool. `value × probability` is the universal HubSpot/Pipedrive primitive; small schema additions (`probability` on stage + deal) immediately upgrade the Kanban and dashboard, then power Pipedrive-style close-date forecasting.

3. **Rotting indicators + required win/loss reasons (#4 + #5)** — two low-cost, high-signal Pipedrive-signature behaviors. Rotting rides on the existing `Deal.updatedAt` (effort S); required loss reasons need a small `CloseReason` model and a tweak to `setDealStatus`, and they feed loss-analysis reporting (#10) that sales managers ask for first.
