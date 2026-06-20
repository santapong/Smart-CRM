# Marketing Research — Competitor Teardown: Pipedrive

**Focus:** Pipedrive is the pipeline-centric SMB sales CRM. This brief distills the Pipedrive features Smart-CRM lacks and that are worth adopting, mapped to our schema/actions/UI. (Synthesized from deep-dive research of Pipedrive's KB, feature pages, developer docs, and pricing, June 2026.)

**Plan-naming note:** Pipedrive rebranded in 2025 from 5 tiers (Essential/Advanced/Professional/Power/Enterprise) to **4 tiers — Lite $14 / Growth $39 / Premium $59 / Ultimate $79** (per seat/mo, annual; no free plan, 14-day trial). Mapping: Essential→Lite, Advanced→Growth, Professional+Power→Premium, Enterprise→Ultimate. Monetization lever is **add-ons** (LeadBooster, Smart Docs, Projects, Campaigns, Web Visitors), three of which are bundled free on Premium/Ultimate.

---

## Feature gaps worth adopting

### 1. Multiple pipelines (Quick Win → Core)
- **Pipedrive:** Unlimited pipelines on *every* tier; each pipeline has its own independent stage set. Not monetized — table stakes.
- **Why it matters:** Teams run distinct processes (New Business vs. Renewals vs. Onboarding). Single-pipeline is the #1 structural limitation of Smart-CRM today.
- **Fit:** `PipelineStage` already has `orgId`; add a `Pipeline` model (`id, orgId, name, order`) and `pipelineId` on `PipelineStage` + `Deal`. Kanban (`src/app/(app)/deals/kanban.tsx`) already groups by `stageId` — add a pipeline selector that filters stages. `moveDealToStage`/`createDeal` in `src/server/actions/deals.ts` gain a `pipelineId`.
- **Effort:** M. **Deps:** none. **Tier:** Core.

### 2. Leads object + Leads Inbox (separate pre-deal stage) (Core)
- **Pipedrive:** A `Lead` is an unqualified opportunity that lives in a **Leads Inbox** (no stage/status), must link to a person/org, shares custom fields with deals, and is **converted to a deal** (carrying person/org, notes, activities). Reverse (deal→lead) also supported. Lead **labels** (Hot/Warm/Cold + custom, color-coded).
- **Why it matters:** Keeps unqualified prospects out of the pipeline; classic CRM lifecycle. Big adoption driver.
- **Fit:** New `Lead` model (`orgId, title, value, currency, ownerId, contactId, companyId, status, source, labelIds`) + `LeadLabel`. New `src/server/actions/leads.ts` with `convertLeadToDeal()`. New `/leads` route + inbox list UI. Reuses Tag-style color labels.
- **Effort:** L. **Deps:** none (custom fields enhance it). **Tier:** Core.

### 3. Products catalog + deal line items + recurring revenue (Core → Strategic)
- **Pipedrive:** A Products catalog (name, code/SKU, unit, prices per currency, cost, tax, variations). Attach products to a deal with **quantity, custom price, % or $ discount, tax**; deal value auto-computes. **Recurring products** (weekly→annual, up to 208 cycles) surface **MRR/ARR/ACV** on the deal (Growth+).
- **Why it matters:** Quoting, accurate deal value, and SaaS/recurring revenue tracking.
- **Fit:** New `Product` + `DealProduct` (line item) models; `Deal.value` becomes derived from line items. New `src/server/actions/products.ts`; products section on deal detail page.
- **Effort:** L. **Deps:** none. **Tier:** Core (catalog) → Strategic Bet (recurring/MRR).

### 4. Smart Docs — quotes/proposals/contracts + eSignature + tracking (Strategic Bet)
- **Pipedrive:** Generate documents from a deal that auto-fill `[merge fields]` and product tables; trackable shareable links (notify on open); native **eSignatures** (up to 10 signers, audit trail, 60-day expiry). Bundled on Premium/Ultimate; $32.50/mo add-on below.
- **Why it matters:** Closes deals in-app; high-value upsell. Strong monetization hook.
- **Fit:** New `Document`/`DocumentTemplate` models + merge-field engine over Deal/Contact/Company/Product; file storage (see backend file-storage brief); a public signed view route. eSign can start via 3rd-party (DocuSign/Dropbox Sign) then go native.
- **Effort:** L. **Deps:** file storage, email, templating. **Tier:** Strategic Bet.

### 5. Workflow automation (trigger → condition → action) (Strategic Bet)
- **Pipedrive:** No-code Automations: event/date triggers, conditions, actions (create activity/deal, update field, send email, notify), **delays**, **wait-for-condition** (≤7 days), **if/else** branches. Per-company limits 50/150/250.
- **Why it matters:** The single biggest "platform" multiplier; recipes like "deal→Won ⇒ create onboarding task + email."
- **Fit:** See backend `14-workflow-automation-engine` brief. Triggers emit from `src/server/actions/*`.
- **Effort:** L. **Deps:** eventing + jobs. **Tier:** Strategic Bet.

### 6. Two-way email sync + templates + tracking + group email (Core)
- **Pipedrive:** Gmail/Outlook/IMAP 2-way sync, templates with merge fields, open/click tracking, scheduled send, and **group emailing** (≤100 recipients, individualized). Smart BCC on all tiers; full sync Growth+.
- **Why it matters:** Email is where SMB sales lives; logging it on the contact/deal is essential.
- **Fit:** RESEND_API_KEY already wired. See marketing `04-email-marketing` + backend `13-email-infrastructure`. Add `EmailMessage` model linked to contact/deal.
- **Effort:** L. **Deps:** email infra. **Tier:** Core.

### 7. Sales sequences / cadences (Core)
- **Pipedrive:** Linear multi-step email+task cadences; steps can auto-send or create activities; auto-enroll via automation.
- **Fit:** `Sequence`/`SequenceStep`/`SequenceEnrollment` models; scheduler via jobs. Builds on email + activities + jobs.
- **Effort:** M–L. **Deps:** email infra, jobs. **Tier:** Core.

### 8. Meeting scheduler / booking links (Quick Win → Core)
- **Pipedrive:** Shareable availability links, Google/Outlook calendar sync, buffers/working hours/min-notice; booking creates an Activity. (Calendly-style.)
- **Fit:** New `BookingPage` model + public booking route; calendar sync via integrations framework; booking creates an `Activity`.
- **Effort:** M. **Deps:** calendar integration. **Tier:** Core.

### 9. Lead capture: web forms, chatbot, live chat, prospector (LeadBooster) (Core)
- **Pipedrive:** Embeddable web forms (block builder, field mapping → Lead/Deal), website Chatbot (playbooks), Live Chat, and Prospector (400M-profile outbound DB). Sold as the $32.50/mo LeadBooster add-on.
- **Fit:** See marketing `05-lead-capture`. Forms + public ingest endpoint are the highest-ROI piece for Smart-CRM.
- **Effort:** M (forms) → L (chat/prospector). **Deps:** public API, lead object. **Tier:** Core.

### 10. Rotting / stale-deal indicators (Quick Win)
- **Pipedrive:** Per-stage "Rotting in N days" turns idle deal cards red; reset on any deal update. On the cheapest paid tier — cheap to copy, high perceived value.
- **Fit:** Add `rottenDays` to `PipelineStage`; compute staleness from `Deal.updatedAt` in the Kanban card (`kanban.tsx`). No new tables.
- **Effort:** S. **Deps:** none. **Tier:** Quick Win.

### 11. Stage/deal probability + weighted pipeline + forecast view (Quick Win → Core)
- **Pipedrive:** Stage probability (0–100%, default 100) and per-deal override; pipeline summary shows weighted value; **Forecast view** buckets deals by expected close date (Premium+).
- **Fit:** Add `probability` to `PipelineStage` and optional `probability` to `Deal`; dashboard already aggregates pipeline value — add weighted value. Forecast view = new dashboard widget grouping by `closeDate`.
- **Effort:** S (probability/weighting) → M (forecast view). **Deps:** none. **Tier:** Quick Win → Core.

### 12. Required / Important fields per pipeline+stage (Quick Win)
- **Pipedrive:** "Important" fields (soft reminder, Growth+) and "Required" fields (hard block on save/stage-move, Premium+), scoped per pipeline+stage — drives data quality.
- **Fit:** Pairs with custom fields engine; store field-requirement rules per stage; enforce in `updateDeal`/`moveDealToStage`.
- **Effort:** M. **Deps:** custom fields. **Tier:** Core.

### 13. Insights report builder + Goals (Core)
- **Pipedrive:** Insights = Reports (measure-by / view-by / segment-by; 5 chart types) + Dashboards + **Goals** (deals/activities/revenue; user/team/company; weekly→yearly; seasonality). Report counts scale by tier.
- **Fit:** See product `04-reporting-dashboards` + backend `15-reporting-analytics-backend`. Needs a `DealStageEvent` history table for funnel/velocity.
- **Effort:** L. **Deps:** stage-event log. **Tier:** Core.

### 14. Open REST API + webhooks + app marketplace (Strategic Bet)
- **Pipedrive:** REST API v2 (cursor pagination, token-based rate limits), webhooks v2, and a 500+ app Marketplace with OAuth apps + UI extension points. API available on all tiers (quota scales).
- **Fit:** See backend `04-public-api`, `07-webhooks-events`, `06-integrations-framework`. Foundational for the ecosystem.
- **Effort:** L. **Deps:** API keys, eventing. **Tier:** Strategic Bet.

---

## Top 3 picks
1. **Multiple pipelines + Leads Inbox** — closes the two biggest structural gaps vs. Pipedrive; both map cleanly onto the existing Deal/Stage model.
2. **Products + deal line items (with recurring/MRR)** — unlocks accurate deal value, quoting, and SaaS revenue tracking.
3. **Workflow automation engine** — the platform multiplier; Pipedrive gates it at Growth+ and it's a primary upgrade driver.
