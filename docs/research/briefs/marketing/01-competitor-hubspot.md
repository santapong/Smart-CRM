# HubSpot Teardown — Feature Gaps for Smart-CRM

_Competitive-intelligence brief · Smart-CRM marketing team · 2026-06-20_

## HubSpot's positioning

HubSpot sells a **single "Customer Platform"** — one shared CRM database (the *Smart CRM*) that every "Hub" (Sales, Marketing, Service, Operations/Data, Commerce) plugs into. The wedge is a genuinely useful **free CRM** (contacts, companies, deals, tasks, email tracking, meeting links, live-chat/shared inbox, up to 1,000 marketing contacts and unlimited free users), and then a tiered upsell as teams outgrow it: **Starter ~$15/seat/mo** (annual; $20 monthly) adds simple automation, removes branding, and unlocks 1:1 sales tooling; **Professional ~$100/seat/mo + a $1,500 one-time onboarding fee** is where the real engine lives (sequences, workflow automation, custom report builder, lead scoring, forecasting, playbooks); **Enterprise ~$150/seat/mo** adds custom objects, predictive scoring, and conversation intelligence.

The strategic lesson for Smart-CRM: HubSpot wins small teams by being *free and broad*, then monetizes **automation, reporting, and revenue tooling**. Most of what makes the free/Starter tiers sticky is well within reach of a Next.js + Prisma app. Below are the gaps, each scored for fit against Smart-CRM's current data model (`prisma/schema.prisma`), server actions (`src/server/actions/*`), and pages (`src/app/(app)/*`).

Sources for positioning/pricing: [protocol80 Sales Hub overview](https://www.protocol80.com/blog/hubspot-sales-hub-what-is-features), [HubSpot Sales Hub pricing guide](https://blog.hubspot.com/sales/hubspot-sales-hub-pricing), [Nutshell on free CRM](https://www.nutshell.com/blog/hubspot-free-crm), [emailtooltester 2026 pricing](https://www.emailtooltester.com/en/crm/hubspot-review/pricing/), [docket Sales Hub pricing 2026](https://docket.io/resources/research/hubspot-sales-hub-pricing).

---

## Feature gaps

### 1. Custom properties (custom fields)

**How HubSpot does it.** Every object (contact, company, deal) ships with editable + custom *properties*. Admins create fields under Settings → Properties, picking a **field type**: single-line text, multi-line text, number, single-checkbox (boolean), dropdown select, multi-select, radio, date picker, and **calculation/rollup** (formulas, date-difference, "time since", aggregations from associated records). It is the backbone of the whole platform — forms, scoring, reports, and workflows all read/write properties.

**Why it matters / who asks.** This is the #1 thing teams hit within weeks: "we need a field for "contract type" / "renewal date" / "lead source"." Without it, every team forces their data into `notes` free-text, which kills filtering and reporting. Asked for by literally every vertical (agencies, SaaS, real estate).

**Fit with Smart-CRM today.** Big gap — the schema has *fixed* columns only. Cleanest fit is an EAV-style add-on: new models `CustomFieldDef { orgId, entityType (CONTACT|COMPANY|DEAL), key, label, fieldType, options[], order }` and `CustomFieldValue { defId, entityId, value (Json/String) }`, all `orgId`-scoped like every other model. New server action `src/server/actions/custom-fields.ts` for CRUD + a values-upsert helper called from `contacts.ts` / `companies.ts` / `deals.ts`. UI: a "Custom fields" tab under `src/app/(app)/settings/page.tsx`, plus dynamic render blocks in `contact-form.tsx`, `company-form.tsx`, `deal-form.tsx` and the detail pages. Defer calculated/rollup fields to a later pass.

**Effort: L.** Dependencies: touches every entity form + detail page; needs a Zod schema generated at runtime per definition.

**Priority: Core.** Unlocks forms, scoring, and reporting later — foundational.

Sources: [HubSpot property field types KB](https://knowledge.hubspot.com/properties/property-field-types-in-hubspot), [Struto on custom properties](https://www.struto.io/blog/demystifying-hubspot-property-fields-and-custom-properties), [HubSpot calculation properties KB](https://knowledge.hubspot.com/properties/create-calculation-properties).

---

### 2. Multiple deal pipelines

**How HubSpot does it.** Deals can belong to **many named pipelines** (e.g. "New Business" vs "Renewals" vs "Partnerships"), each with its own ordered stages. Best-practice guidance is to split a pipeline only when the "definition of done" for a stage changes. Each deal is assigned to exactly one pipeline; the board, reports, and forecasts filter by pipeline.

**Why it matters / who asks.** Any team running more than one motion (new-biz vs renewals, or multiple product lines) needs this fast. A single Kanban forces unrelated deals into one funnel and makes win-rate metrics meaningless.

**Fit with Smart-CRM today.** Close fit. Today `PipelineStage` is `orgId`-scoped and `Deal.stageId` points at it. Add a `Pipeline { id, orgId, name, order }` model, give `PipelineStage` a `pipelineId`, and add `Deal.pipelineId`. Update `src/server/actions/deals.ts` (and stage CRUD, likely in `org.ts`) to scope by pipeline. UI: a pipeline switcher on `src/app/(app)/deals/page.tsx` driving `kanban.tsx`; pipeline management in settings. Migration must backfill an existing default pipeline for current stages/deals.

**Effort: M.** Dependencies: data migration/backfill; the Kanban (`@dnd-kit`) and dashboard pipeline chart (`dashboard/pipeline-chart.tsx`) need a pipeline filter.

**Priority: Core.** Common, well-scoped, high perceived value.

Sources: [Vantage Point deal/ticket pipelines](https://vantagepoint.io/blog/hs/deal-ticket-pipelines-stages-best-practices), [forecastio pipeline stages](https://forecastio.ai/blog/hubspot-sales-pipeline-stages), [Octave pipeline automation](https://www.octavehq.com/post/hubspot-deal-pipeline-automation-guide).

---

### 3. Email tracking + send-from-CRM + templates/snippets

**How HubSpot does it.** Even on the **free tier**, reps connect Gmail/Outlook, send 1:1 email from the contact record, and get notified on **opens and link clicks** (via a tracking pixel + wrapped links). Free includes 3 shared **templates** and 3 **snippets** (reusable text blocks); Starter raises the limits and adds 1:1 sequences-lite. Every send is logged on the contact timeline automatically.

**Why it matters / who asks.** "Did they open it?" is the single most-requested sales signal. Logging email to the timeline also kills the manual "log a call/note" busywork. SDRs and AEs ask for this on day one.

**Fit with Smart-CRM today.** Medium-large because there's **no email at all** today (no provider, `Account` table exists from NextAuth but no Gmail/Graph scopes wired). Phase 1 (realistic): an outbound transactional sender (Resend/Postmark) + a tracking pixel route under `src/app/api/track/open/[id]/route.ts` and a click-redirect route, writing an `EmailMessage` model (`orgId, contactId, dealId, subject, body, sentAt, openedAt, clickedAt, ownerId`). Surface a "Log email / Send email" action on the contact detail page (`src/app/(app)/contacts/[id]/page.tsx`) and render it in the activity timeline alongside `Activity`. `EmailTemplate { orgId, name, subject, body }` + `Snippet { orgId, shortcut, body }` are trivial CRUD (mirror `tags.ts`). Phase 2 (Gmail/Graph two-way sync) is a separate, larger effort.

**Effort: M** (Phase 1 outbound + tracking + templates). Dependencies: an email provider + domain/DKIM; a public unauthenticated route for the pixel.

**Priority: Core.** Closes the most visible MVP gap and is the gateway to sequences (#6).

Sources: [HubSpot snippets KB](https://knowledge.hubspot.com/conversations/use-snippets), [bluleadz free tools](https://www.bluleadz.com/blog/hubspot-free-marketing-tools), [mediaposte free vs paid](https://blog.mediaposte-martech.com/whats-included-in-the-free-vs-paid-hubspot-plans).

---

### 4. Meeting scheduler (booking links)

**How HubSpot does it.** A personal **booking page** synced to the rep's Google/Outlook calendar; prospects pick an open slot, the meeting is created on both calendars, and a contact + meeting record is auto-created/logged in the CRM. Higher tiers add **round-robin** and **group** meetings and embeddable widgets. Free includes a basic 1:1 link.

**Why it matters / who asks.** Eliminates the email back-and-forth to book a call; it's a top reason teams adopt Sales Hub even at free. Every AE and customer-success rep wants their own link.

**Fit with Smart-CRM today.** Medium. Requires calendar availability — either a stored weekly-availability model (`AvailabilityRule { userId, weekday, startMin, endMin }`) for an MVP, or Google/Microsoft calendar OAuth for real free/busy (the `Account` table already exists for OAuth tokens). New `MeetingType { orgId, ownerId, slug, durationMin }` and `Booking { meetingTypeId, contactId, startAt, endAt }`; a **public** route `src/app/book/[slug]/route.tsx` outside the authed `(app)` group. On booking, create a `Contact` if new and an `Activity` of type `MEETING` — reusing existing models nicely.

**Effort: M** (MVP with manual availability) / **L** (with live calendar sync). Dependencies: timezone handling; optional Google/MS Calendar OAuth + an ICS generator.

**Priority: Core.** High user delight, and it feeds contacts + activities into the existing model.

Sources: [HubSpot meeting scheduler product page](https://www.hubspot.com/products/sales/schedule-meeting) (search snippet; page blocks direct fetch), [protocol80 Sales Hub overview](https://www.protocol80.com/blog/hubspot-sales-hub-what-is-features).

---

### 5. Workflow automation engine

**How HubSpot does it.** The Professional-tier crown jewel. **Workflows** enroll records on a trigger (form submit, property change, list membership, deal-stage change, schedule) and run **actions**: send email, set a property, create a task, rotate/assign an owner, send an internal notification, add delays/branches (if/then). Contact-, company-, and deal-based workflows are distinct types.

**Why it matters / who asks.** This is what converts a CRM from a system of record into a system of action — auto-assign new leads, auto-create a follow-up task when a deal moves stage, notify the owner on a stalled deal. Ops/RevOps and managers ask for it; it's HubSpot's biggest paid differentiator.

**Fit with Smart-CRM today.** Large — nothing exists. Needs a rules model (`Workflow { orgId, entityType, trigger (Json), enabled }`, `WorkflowAction { workflowId, order, type, config (Json) }`, `WorkflowRun` for logging/idempotency) and an **execution mechanism**: emit domain events from existing server actions (e.g. after a `deals.ts` stage update) into an evaluator, plus a scheduled runner for time-based triggers (a Vercel Cron route under `src/app/api/cron/workflows/route.ts`). UI is a builder under a new `src/app/(app)/automation/` section. Start with a constrained v1 (trigger = deal stage change / contact created; actions = create task, set field, send email) before a generic if/then graph.

**Effort: L.** Dependencies: a job/cron mechanism; clean event hooks in every server action; idempotency to avoid double-fires. Best after custom fields (#1) since "set property" needs them.

**Priority: Strategic Bet.** Highest moat, highest effort — phase it.

Sources: [HubSpot choose workflow actions KB](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions), [HubSpot create workflows KB](https://knowledge.hubspot.com/workflows/create-workflows), [Activepieces workflow examples](https://www.activepieces.com/blog/hubspot-automation-workflows).

---

### 6. Sales sequences (multi-step cadences)

**How HubSpot does it.** A **sequence** is an automated multi-step follow-up cadence enrolled per-contact: e.g. Day 0 email → Day 2 task to call → Day 5 email, with steps auto-pausing when the prospect replies or books. Gated at Professional. Distinct from marketing workflows — it's 1:1 rep outreach.

**Why it matters / who asks.** SDRs/AEs live in sequences; "set it and forget the follow-ups" is the core productivity win of Sales Hub. Drives consistent prospecting without manual reminders.

**Fit with Smart-CRM today.** Large, and depends on email (#3) + a scheduler/automation runtime (#5). Models: `Sequence { orgId, name }`, `SequenceStep { sequenceId, order, type (EMAIL|TASK), delayDays, templateId? }`, `SequenceEnrollment { sequenceId, contactId, status, currentStep, nextRunAt }`. A cron route advances due enrollments, sending email or spawning an `Activity` task; reply-detection auto-unenrolls. Surface "Enroll in sequence" on the contact detail page.

**Effort: L.** Dependencies: **email (#3) and the scheduled runner from #5** — build those first.

**Priority: Strategic Bet.** High value but sits on top of two other big items.

Sources: [protocol80 Sales Hub overview](https://www.protocol80.com/blog/hubspot-sales-hub-what-is-features), [CRM News Today on Starter sequences](https://crmnewstoday.com/hubspot-sales-hub-starter-sequences-guide/), [docket Sales Hub review](https://docket.io/resources/research/hubspot-sales-hub-review).

---

### 7. Forms + lead capture

**How HubSpot does it.** Drag-and-drop **forms** and pop-ups (no code) that you embed on any site; submissions auto-create/update a contact and can trigger workflows. Marketing Hub Starter removes HubSpot branding. Form fields map directly to CRM properties.

**Why it matters / who asks.** It's how leads *get into* the CRM in the first place — "contact us," demo requests, newsletter signups. Marketers and founders ask for it; without it, lead entry is manual.

**Fit with Smart-CRM today.** Medium. Models: `Form { orgId, name, slug, fields (Json mapping to contact fields / custom fields) }`, `FormSubmission { formId, contactId, payload (Json), createdAt }`. A **public** ingest route `src/app/api/forms/[slug]/submit/route.ts` (CORS-enabled, rate-limited) that upserts a `Contact` scoped to the form's `orgId` and records the submission on the timeline. Embed = a tiny script or iframe served from a public `src/app/forms/[slug]/page.tsx`. Pairs naturally with custom fields (#1) for field mapping and workflows (#5) for "on submit" automation.

**Effort: M.** Dependencies: public/CORS route + spam protection (honeypot/Turnstile); benefits from custom fields.

**Priority: Core.** Turns Smart-CRM from inward-facing into a lead-generation tool.

Sources: [HubSpot Marketing Hub Starter (LZC)](https://lzcmarketing.com/blog/hubspot-marketing-hub-starter-what-to-know/), [aspiration on Marketing Hub](https://blog.aspiration.marketing/en/what-is-the-hubspot-marketing-hub), [insidea Marketing tiers](https://insidea.com/blog/hubspot/difference-between-hubspot-marketing-free-starter-pro-enterprise/).

---

### 8. Custom report builder + dashboards

**How HubSpot does it.** Beyond canned reports, a **custom report builder** lets users pick objects (contacts/companies/deals/custom), choose dimensions/measures, filter, visualize (bar/line/funnel/table), save, and pin multiple reports onto **named dashboards** (with dashboard-level filters). Single-object reports are broadly available; cross-object reporting is a paid step up.

**Why it matters / who asks.** Managers want pipeline-by-stage, win-rate by owner, activities-per-rep, revenue-by-month — without exporting to a spreadsheet. Reporting is consistently the reason teams move *up* HubSpot tiers.

**Fit with Smart-CRM today.** Medium. Today there's only a fixed `dashboard/page.tsx` with KPIs and one `pipeline-chart.tsx` (recharts already in the stack). A pragmatic v1: a `SavedReport { orgId, name, entity, groupBy, measure, filters (Json), chartType }` model + a query-builder server action that compiles to safe Prisma `groupBy`/aggregations (whitelisted fields only — no raw SQL). UI under `src/app/(app)/reports/` reusing recharts. Lean on existing single-object aggregates first (deals by stage/owner, activities by type/owner); cross-object joins later.

**Effort: M** (single-object v1) / **L** (cross-object + dashboard layout engine). Dependencies: a strict field whitelist to keep queries safe and `orgId`-scoped; richer once custom fields (#1) exist.

**Priority: Core.** Direct upsell driver and a frequent evaluation checkbox.

Sources: [HubSpot custom report builder KB](https://knowledge.hubspot.com/reports/create-reports-with-the-custom-report-builder), [Huble on cross-object reporting](https://huble.com/blog/hubspots-updated-report-builder-and-cross-object-reporting), [HubSpot reporting/dashboards product page](https://www.hubspot.com/products/reporting-dashboards).

---

### 9. Lead scoring

**How HubSpot does it.** Two flavors. **Manual ("HubSpot Score")** is a property where admins write additive rules (page visit +5, target job title +10, unsubscribe −20) that recompute automatically. **Predictive ("Likelihood to close" / "Contact priority")** is ML-trained on the org's own closed-won/closed-lost history (Enterprise). 2025 added explainability showing which signals drove a score.

**Why it matters / who asks.** Tells reps *who to call first*. Marketing/sales-ops use it to define the MQL→SQL handoff. Becomes valuable once there's enough engagement data (email opens, form fills, activities) to score on.

**Fit with Smart-CRM today.** Medium, but **dependent on signals** that don't exist yet (email opens #3, form fills #7). MVP can score on data already present: activity counts/recency, deal association, title keywords. Add `Contact.score Int @default(0)` plus `ScoreRule { orgId, condition (Json), points }`; recompute in a nightly cron or on relevant writes (reuse the #5 event hooks). Surface the score as a sortable column on `src/app/(app)/contacts/page.tsx` and on the detail page. Predictive/ML is out of scope for a small team — manual rules deliver 80% of the value.

**Effort: M.** Dependencies: best after #1 (rules read custom fields) and #3/#7 (richer signals); needs a recompute trigger.

**Priority: Strategic Bet.** Real value, but lower until the upstream signal sources exist.

Sources: [pixcell lead scoring 2025](https://www.pixcell.io/blog/lead-scoring-hubspot), [xcellimark lead scoring guide](https://www.xcellimark.com/blog/how-to-build-lead-scoring-in-hubspot-2025-update), [FlowRunner predictive scoring](https://flowrunner.ai/blog/predictive-lead-scoring-hubspot/).

---

### 10. Lifecycle stages

**How HubSpot does it.** A standard contact/company property tracking funnel position: **Subscriber → Lead → MQL → SQL → Opportunity → Customer → Evangelist**. It auto-advances via workflows or deal sync (creating a deal → "Opportunity"; winning it → "Customer"). It's the shared vocabulary across marketing and sales, and the backbone of funnel reporting.

**Why it matters / who asks.** Lets a team see "how many leads vs customers" and measure conversion between stages — the core marketing-funnel metric. Marketers expect it; it also cleanly separates "lead status" (micro) from lifecycle (macro).

**Fit with Smart-CRM today.** Small. Add `enum LifecycleStage` + `Contact.lifecycleStage` (and optionally on `Company`), with a sane default of `LEAD`. Optionally auto-set to `CUSTOMER` when a `Deal` is marked `WON` in `deals.ts` (the status enum already exists). Filter/column on the contacts list; a funnel count on the dashboard. Very low-risk, pairs with scoring (#9) and reporting (#8).

**Effort: S.** Dependencies: none for the field; the auto-advance hook is a one-liner in the existing deal-win path (and gets richer with workflows #5).

**Priority: Quick Win.** Tiny effort, instantly improves segmentation and funnel reporting.

Sources: [Blend B2B lifecycle stages](https://www.blendb2b.com/blog/hubspots-lifecycle-stages-explained), [HubSpot lifecycle stages KB](https://knowledge.hubspot.com/object-settings/create-and-customize-lifecycle-stages), [hublead lifecycle stages](https://www.hublead.io/blog/hubspot-lifecycle-stages).

---

### 11. Required/conditional fields per deal stage + deal rot alerts

**How HubSpot does it.** **Conditional stage properties**: moving a deal into a stage pops a modal requiring specified fields (e.g. "Close Date" + "Contract Value" before "Contract Sent"). Plus **deal-rot** automation that flags deals idle in a stage beyond X days (the "Stalled Deals" preset uses 20% over the team's historical average). Keeps the pipeline clean and forecasts honest.

**Why it matters / who asks.** Managers get reliable data and catch stalled deals before they die. It's the cheapest lever for forecast accuracy and rep discipline.

**Fit with Smart-CRM today.** Small–medium. Extend `PipelineStage` with `requiredFields (Json)` and add `rotAfterDays Int?`. Enforce required fields in the stage-change path in `src/server/actions/deals.ts` and prompt for them in `kanban.tsx` / `deal-form.tsx` on drag-to-stage. "Rotting" = a derived check (`updatedAt` older than `rotAfterDays`) shown as a badge on Kanban cards and a dashboard list — computable today with no new infra, or push notifications later via workflows (#5).

**Effort: S** (rot badge + required-field guard) / **M** (with per-stage config UI). Dependencies: pairs with custom fields (#1) so required fields can include custom ones; richer with pipelines (#2).

**Priority: Quick Win.** Mostly leverages existing fields; strong manager appeal for low cost.

Sources: [babelquest pipeline rules](https://www.babelquest.co.uk/en/hubspot-hacks/-how-to-set-up-hubspot-pipeline-rules-for-better-deal-management), [Octave deal pipeline automation](https://www.octavehq.com/post/hubspot-deal-pipeline-automation-guide), [Simple Machines deal maintenance](https://www.simplemachinesmarketing.com/blog/5-ways-to-automate-deal-pipeline-maintenance-hubspot/).

---

### 12. Quotes / line items / product library (CPQ)

**How HubSpot does it.** A **product library** of reusable line items feeds branded **quotes** generated from a deal — cover letter, line items (flat or tiered), auto-calculated totals/taxes, **e-signature** and **payment** collection (HubSpot Payments/Stripe). Now an AI-powered CPQ flow; gated at Professional+ of the Commerce/Revenue side.

**Why it matters / who asks.** Closes the loop from "deal" to "signed + paid" without leaving the CRM. Asked for by teams that send proposals — agencies, services, B2B sellers.

**Fit with Smart-CRM today.** Large and broad. Models: `Product { orgId, name, unitPrice, currency }`, `LineItem { dealId, productId?, name, qty, unitPrice }`, `Quote { dealId, status, total, publicToken, signedAt }`. A **public** quote-view route `src/app/quote/[token]/route.tsx` for accept/sign; PDF generation; payments is a whole separate integration (Stripe). The `Deal.value` field could be derived from line items. This is closer to a "Commerce" expansion than core CRM.

**Effort: L.** Dependencies: PDF rendering; e-sign capture; Stripe for payments; currency/tax handling. Build product library + line items first; quotes/sign/pay as later phases.

**Priority: Strategic Bet.** Valuable for revenue teams but heavy and adjacent to the CRM core — sequence it after automation/reporting.

Sources: [HubSpot quotes product page](https://www.hubspot.com/products/revenue/quotes), [HubSpot line items KB](https://knowledge.hubspot.com/products/edit-products-and-terms-in-the-line-items-editor), [HubSpot e-signatures KB](https://knowledge.hubspot.com/quotes/use-e-signatures-with-quotes).

---

### 13. Shared inbox / conversations (live chat + email)

**How HubSpot does it.** A **conversations inbox** routes inbound channels (team email aliases, live website chat, chatbots) into one shared queue any teammate can pick up and reply to; threads link to the contact record. Live chat and the shared inbox are available **free**.

**Why it matters / who asks.** Small teams want one place for inbound without a separate helpdesk; live chat captures website visitors in real time and creates contacts. Support-leaning teams and founders ask for it.

**Fit with Smart-CRM today.** Large — no inbound channels exist. Live chat needs a public widget + a realtime transport (WebSocket/SSE or a service like Pusher), `Conversation`/`Message` models scoped by `orgId`, and an inbox UI under `src/app/(app)/inbox/`. Inbound email-to-inbox needs an inbound-parse webhook (Postmark/Mailgun). Conceptually overlaps with the Activity timeline but is a distinct realtime surface.

**Effort: L.** Dependencies: realtime infra; inbound email webhook; a public chat widget + spam controls. Builds naturally on email (#3).

**Priority: Strategic Bet.** Differentiated and sticky, but infra-heavy; lower than the sales-core gaps for a small-team CRM.

Sources: [HubSpot conversations product page](https://www.hubspot.com/products/crm/conversations), [Meticulosity conversation inbox guide](https://meticulosity.com/blog/hubspot-conversation-inbox-guide), [bluleadz free tools](https://www.bluleadz.com/blog/hubspot-free-marketing-tools).

---

### 14. Duplicate management (dedupe + merge)

**How HubSpot does it.** A built-in **duplicate manager** surfaces likely-duplicate contacts/companies (matched on email, name, phone, domain, etc.) and offers one-click **merge**; Operations Hub adds ML matching and higher bulk limits. It's free for basic use and prevents the data rot every CRM accumulates.

**Why it matters / who asks.** Imports and form fills inevitably create dupes; a messy database undermines trust in every report. Admins and ops ask for it once data volume grows.

**Fit with Smart-CRM today.** Small–medium and very self-contained. A server action in `contacts.ts`/`companies.ts` that finds candidates (same `email`, or fuzzy `firstName+lastName` / `domain`) and a `merge(primaryId, dupeId)` that re-points child relations (`Deal`, `Activity`, `ContactTag`) to the primary and deletes the dupe — all already `orgId`-scoped. UI: a "Manage duplicates" view in settings plus a "Merge" button on detail pages. No new infra, no external deps.

**Effort: S** (exact-match merge) / **M** (fuzzy candidate scoring + bulk). Dependencies: none — uses existing models and cascade rules.

**Priority: Quick Win.** Low effort, no dependencies, clear data-hygiene payoff.

Sources: [HubSpot dedup guide](https://blog.hubspot.com/customers/the-ultimate-guide-to-your-new-deduplication-tool-hubspot), [hublead duplicate contacts](https://www.hublead.io/blog/hubspot-duplicate-contacts), [koalify bulk merge](https://koalify.io/blog/how-to-bulk-merge-hubspot-duplicates-contacts-companies-more).

---

## Top 3 picks

1. **Custom properties (#1) — Core, effort L.** The single highest-leverage gap: it's the foundation forms, lead scoring, reporting, and workflow "set property" all build on, and it's the first wall every team hits. Build it first so later features compound.
2. **Multiple deal pipelines (#2) — Core, effort M.** Well-scoped, maps almost directly onto the existing `PipelineStage`/`Deal` models, and removes a glaring single-Kanban limitation that blocks any team running more than one sales motion. Best effort-to-impact ratio of the Core tier.
3. **Email tracking + send-from-CRM + templates (#3) — Core, effort M.** Closes the most visible MVP gap ("no email"), delivers the #1 requested signal (opens/clicks) on the contact timeline, and is the prerequisite for sequences (#6) and lead scoring (#9) — a strategic on-ramp, not just a feature.

_Quick-win starters to ship alongside (cheap, no dependencies): lifecycle stages (#10), duplicate merge (#14), and deal-rot badges + required-fields-per-stage (#11)._
