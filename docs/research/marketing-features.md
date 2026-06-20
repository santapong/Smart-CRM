# Smart-CRM — Marketing & Growth Features (Consolidated Research)

_Consolidated by the Marketing Research lead from nine team briefs · 2026-06-20_

Smart-CRM today is a clean, multi-tenant sales system of record — Contacts, Companies,
Deals (Kanban), Activities, a dashboard, and ⌘K search — but it has **no way for the
outside world to enter the CRM and no way to act on the data inside it**: no email,
forms, automation, lead object, scoring, attribution, or integrations. This report
consolidates nine research briefs (three competitor teardowns plus email, lead capture,
marketing automation, integrations, analytics, and pricing) into one prioritized view of
the marketing/growth surface area and how each piece maps onto the existing
`prisma/schema.prisma` + `src/server/actions/*` patterns.

**Market positioning takeaway.** The SMB CRM market splits into two camps: **broad
"customer platforms"** (HubSpot, Zoho, Salesforce) that win with a free/cheap wedge and
monetize automation + reporting + AI, and **pipeline-first sales tools** (Pipedrive,
Freshsales) that win on focus and price. Smart-CRM's wedge is to be **Pipedrive-simple
on the sales core but HubSpot-broad on the few features SMBs actually adopt** —
email-on-the-record, embeddable forms→leads, a linear no-code automation builder, and
funnel/source analytics — priced to **undercut Pipedrive ($14/$39/$59) while matching
Zoho/Freshsales value**, fronted by a generous free 3-user tier. The single credible
_differentiator_ (vs. every competitor gating it to top tiers) is **shipping
Claude-powered AI assistance early and low** (email drafting, deal-risk summaries, NL
search). The table-stakes gaps below are disqualifying in head-to-head evaluations; the
strategic bets are where Smart-CRM earns a moat.

> **Backend dependency note.** Several features below depend on platform substrate owned
> by the backend team (email infra, public API, webhooks/outbox, job/cron runner,
> rate-limiting, file storage, billing). Those are tracked in the sibling
> [`docs/research/backend-design.md`](./backend-design.md); cross-references appear
> inline as **[backend: …]**.

---

## 1. Competitor landscape

Pricing is per seat/month on annual billing, as gathered in the briefs (June 2026).

| Vendor | Free tier | Entry / Mid / Top (SMB) | Standout features | Key gaps Smart-CRM can exploit |
|---|---|---|---|---|
| **HubSpot** | Yes — free CRM, unlimited users, ~1,000 mktg contacts | **$15** Starter / **$90** Pro / **$150** Ent (+$1.5k/$3.5k onboarding) | Free CRM wedge; workflows, sequences, custom report builder, lead scoring, forms, lifecycle stages, conversations inbox | Expensive jump to Pro + onboarding fees; complexity overwhelms small teams; gating of basic automation |
| **Pipedrive** | No (14-day trial) | **$14** Lite / **$39** Growth · **$59** Premium / **$79** Ultimate | Best-in-class pipeline UX; unlimited pipelines all tiers; Insights (funnel/duration); LeadBooster, Smart Docs add-ons | No free tier; thin marketing/email-campaign depth; add-ons inflate real price; weaker reporting at low tiers |
| **Zoho CRM** | Yes (3 users) | **$14** Std / **$23** Pro · **$40** Ent / **$52** Ultimate | Aggressive pricing; Blueprint (process+SLA), Canvas (no-code UI), huge marketplace | AI (Zia) gated to Enterprise; UI sprawl; multi-pipeline/custom modules gated to Pro+ |
| **Freshsales** | Yes (3 users, incl. phone/email/chat) | **$9** Growth / **$39** Pro / **$59** Ent | Generous free tier with built-in telephony; rule + Freddy AI scoring; sequences | Real AI/scoring/multi-pipeline gated to Pro; telephony usage-billed on top |
| **Salesforce** | No | **$25** Starter / **$100** Pro Suite (Ent $165+) | Flow Builder, custom objects, AppExchange ecosystem at scale | Starter barely customizable; steep price + complexity for SMB; real Einstein AI Enterprise+ |
| **Zoho Bigin** _(SMB benchmark)_ | Yes (1 user) | **$7** / **$12** / **$18** | Lightweight pipeline CRM; the "simple & cheap" floor | n/a (reference point for the low end) |

**Cross-competitor patterns.**
- **Free tier is the norm** (HubSpot, Zoho, Freshsales, Bigin) — only Pipedrive and
  Salesforce withhold it. A free 3-user plan is a strong acquisition wedge.
- **Entry paid clusters at $9–$15;** the **mid tier ($23–$59) is the real revenue tier**,
  unlocking email sync, automation, multiple pipelines, and reporting.
- **Automation, reporting, and AI are the universal top-tier upsell levers.**
- **Table-stakes every CRM has:** custom fields, multiple pipelines, workflow automation,
  web forms, built-in email, lead scoring, reports/dashboards, assignment rules,
  sequences. Their absence is disqualifying for buyers comparing CRMs — and Smart-CRM is
  currently missing **all of them**.
- **Differentiators to copy selectively:** Zoho's Blueprint (process+SLA) and Canvas
  (no-code UI), Freshsales' built-in telephony + generous free tier, Salesforce's
  Flows+AppExchange, Pipedrive's LeadBooster bundle. **AI is the live battleground** —
  all three platforms gate real AI behind top tiers/add-ons, so shipping it earlier and
  lower is Smart-CRM's clearest wedge.

---

## 2. Feature gaps vs competitors — master table

De-duplicated across all nine briefs (email, forms, automation, integrations, analytics,
and the three teardowns overlap heavily; each row is the merged view).
**Effort:** S ≈ days–1 sprint · M ≈ 1–2 sprints · L ≈ multi-sprint/quarter.
**Tier:** Quick Win · Core · Strategic Bet.

| # | Feature | Who does it / evidence | Smart-CRM fit | Effort | Tier |
|---|---|---|---|---|---|
| 1 | **Custom fields (properties)** | HubSpot, Zoho, Freshsales, Salesforce, Pipedrive — all | EAV `CustomFieldDef`/`CustomFieldValue` per CONTACT/COMPANY/DEAL; dynamic Zod + form blocks. Foundation for forms/scoring/reports/automation | L | Core |
| 2 | **Multiple deal pipelines** | All five; Pipedrive unlimited on every tier | Add `Pipeline`; `pipelineId` on `PipelineStage`+`Deal`; pipeline switcher on Kanban. Backfill default pipeline | M | Core |
| 3 | **Lifecycle stages** | HubSpot (Subscriber→…→Customer), automation brief | `enum LifecycleStage` + `Contact.lifecycleStage`; auto→CUSTOMER on deal WON in `deals.ts` | S | Quick Win |
| 4 | **Lead object + Leads Inbox** | Pipedrive Leads Inbox (separate from deals) | New `Lead` model + `/leads` inbox + `convertLead()` txn → Contact/Deal. Keystone for capture | M | Core |
| 5 | **1:1 tracked email from record** | HubSpot/Pipedrive bread-and-butter | `EmailMessage` + `EMAIL` ActivityType; `sendContactEmail` via Resend; logs to timeline. **[backend: email infra]** | M | Core |
| 6 | **Email templates + snippets + merge vars** | HubSpot, Pipedrive, Mailchimp | `Template { subject, bodyHtml }` + `src/lib/merge.ts`; React Email layouts. Mirrors `tags.ts` CRUD | M | Core |
| 7 | **Open/click tracking (webhooks)** | Universal; Pipedrive/HubSpot pixel+redirect | Resend Svix webhook `→ EmailMessage` status/counts; auto-suppress bounces/complaints. **[backend: webhook route]** | M | Core |
| 8 | **Unsubscribe & compliance (suppression, 1-click)** | CAN-SPAM/GDPR; Google/Yahoo 1-click >5k/day | `subscriptionStatus` on Contact + `Suppression`; public unsub route; `List-Unsubscribe` headers. Gate before any bulk | M | Core |
| 9 | **Bulk / broadcast email to segment** | Pipedrive Campaigns, Mailchimp | `Campaign`/`CampaignRecipient`; batch send throttled to 2 req/s. **[backend: job runner]** | L | Strategic Bet |
| 10 | **Drip / sequences (cadences)** | HubSpot, Pipedrive, Zoho, Freshsales | `Sequence`/`Step`/`Enrollment`; cron advances; stop-on-reply/unsub. **[backend: scheduler]** | L | Strategic Bet |
| 11 | **A/B subject-line testing** | HubSpot, Mailchimp | `CampaignVariant`; deterministic split, winner by opens (note pixel caveat) | M | Strategic Bet |
| 12 | **Drag-and-drop email builder** | Pipedrive, Mailchimp | `bodyJson` block tree → HTML compiler; reuse dnd-kit. Prefer React Email / Resend hosted editor first | L | Strategic Bet |
| 13 | **Transactional system emails** | Resend core use case | `sendEmail()` from auth/invite flows (NextAuth can't email today). Validates the pipe | S | Quick Win |
| 14 | **Inbound reply capture / two-way threading** | HubSpot/Pipedrive log replies | Resend inbound `email.received`; `direction`/`inReplyTo` on EmailMessage. **[backend: inbound MX]** | L | Strategic Bet |
| 15 | **Embeddable web forms + FormSubmission** | HubSpot, Pipedrive, Zoho, Salesforce | `Form`/`FormSubmission`; **public** ingest route upserts Lead. First public write endpoint. **[backend: public API, CORS]** | L | Core |
| 16 | **Hosted landing pages** | Pipedrive/HubSpot/Typeform hosted URLs | `/p/[slug]` public RSC reusing the form component; presentational | M | Core |
| 17 | **Source & UTM capture (first-touch)** | Typeform hidden fields; attribution standard | `utm*`/`source`/`referrer` on Lead+Contact+Deal; immutable first-touch; `@@index([orgId, source])` | S | Quick Win |
| 18 | **Multi-step / progressive-profiling forms** | HubSpot progressive profiling; Typeform logic | `step`+`showIf` in `Form.fields`; returning-visitor token. ~86% higher conversion | M | Strategic Bet |
| 19 | **Spam protection (honeypot + CAPTCHA)** | Industry standard for public forms | Honeypot + timing + disposable-email block in route; optional Turnstile. Ship with first form | S | Quick Win |
| 20 | **Rate limiting / abuse controls** | Universal for public endpoints | `rateLimit()` helper; in-memory v1, Redis durable. Non-negotiable before public launch. **[backend: rate-limit infra]** | S/M | Quick Win |
| 21 | **Lead / contact scoring (rule-based)** | HubSpot, Zoho, Freshsales, Salesforce | `score` + `ScoringRule` (fit+engagement); pure `scoreLead()`, Cold/Warm/Hot tiers. Predictive later | M | Core |
| 22 | **Dedupe on capture + merge** | HubSpot (can't be turned off), Zoho | `findDuplicate()` on `[orgId, email]`; `merge()` reparents children in txn; per-form dedupMode | S/M | Quick Win |
| 23 | **Public Leads API (key auth)** | Typeform webhook→endpoint; every CRM | `ApiKey` (hashed) + `/api/v1/leads`; shares ingest core with forms. **[backend: public API]** | M | Core |
| 24 | **Live-chat + chatbot widget** | Pipedrive LeadBooster, Drift/Intercom | `ChatPlaybook`/`Conversation`/`Message`; bot-only v1, live takeover needs realtime. **[backend: realtime]** | L | Strategic Bet |
| 25 | **Meeting scheduler / booking links** | HubSpot, Pipedrive, Calendly | `MeetingType`/`Booking` + public `/book/[slug]`; creates Contact+MEETING Activity. **[backend: calendar OAuth]** | M | Core |
| 26 | **No-code workflow automation** | All five; HubSpot/Pipedrive headline | `Automation`/`Step`/`Run`; emit events from server actions; linear builder first. **[backend: event bus + jobs]** | L | Strategic Bet |
| 27 | **Smart lists / dynamic segments** | HubSpot active lists, Customer.io | `Segment { rules Json, syncTagId? }`; shared filter-expr engine; Tag-backed recompute | M | Core |
| 28 | **Segment-change enrollment trigger** | Customer.io headline trigger | Recompute job diffs membership → `segment.entered/left` events feed automation | M | Strategic Bet |
| 29 | **Nurture journeys (delays/waits)** | ActiveCampaign, Customer.io, Pipedrive | Delay/Wait step on the builder; ship 3–5 clone-and-go templates. **[backend: scheduler]** | M/L | Strategic Bet |
| 30 | **Round-robin / assignment routing** | HubSpot "rotate to owner", Pipedrive, Zoho | Automation action sets `Deal.ownerId`/`Contact.ownerId` from `Membership` pool | S | Core |
| 31 | **Internal notifications + task auto-create** | HubSpot, Pipedrive, ActiveCampaign | "Create task" = `createActivity`; in-app notify first, email thin add. Day-one value | S | Quick Win |
| 32 | **Conditional branching (If/Then) + Goals** | HubSpot (Pro+), ActiveCampaign | Branch/goal node types reusing filter-expr schema. Paid-gating candidate | L | Strategic Bet |
| 33 | **Automation recipe library** | Pipedrive 36, ActiveCampaign 900+ | Seeded `Automation` JSON users clone. #1 adoption lever once builder exists | S/M | Core |
| 34 | **Automation run history / log** | Customer.io, HubSpot enrollment history | `AutomationRun` rows + per-record timeline line + kill-switch. Trust/retention | S/M | Core |
| 35 | **Required/conditional fields per stage** | HubSpot, Pipedrive (Premium) | `requiredFields` on `PipelineStage`; enforce in `moveDealToStage`; prompt on drag | S/M | Quick Win |
| 36 | **Deal-rot / stale-deal indicators** | Pipedrive "rotting in N days", HubSpot | `rotAfterDays` on stage; derive from `Deal.updatedAt`; red badge on Kanban. No new infra | S | Quick Win |
| 37 | **Stage probability + weighted pipeline + forecast** | Pipedrive | `probability` on stage/deal; weighted value on dashboard; forecast widget by closeDate | S/M | Quick Win |
| 38 | **Process + SLA (Zoho Blueprint)** | Zoho Blueprint (states+transitions+SLA) | Allowed stage transitions + required fields per transition; enforce in `moveDealToStage` | L | Strategic Bet |
| 39 | **Products catalog + deal line items** | HubSpot, Pipedrive | `Product`/`DealProduct`; `Deal.value` derived from line items | L | Core |
| 40 | **Recurring revenue / MRR-ARR** | Pipedrive (Growth+) | Recurring `DealProduct` → MRR/ARR on deal | L | Strategic Bet |
| 41 | **Quotes / Smart Docs + e-signature** | HubSpot CPQ, Pipedrive Smart Docs, PandaDoc | `Document`/`Template` + merge engine; public signed view; eSign via 3rd-party first. **[backend: file storage]** | L | Strategic Bet |
| 42 | **Custom report builder + dashboards** | HubSpot, Pipedrive Insights, Zoho | `SavedReport` compiling to whitelisted Prisma `groupBy`; recharts. Single-object first | M/L | Core |
| 43 | **Stage-transition event log** | Required by Pipedrive duration/progress | `DealStageEvent` appended in `deals.ts` txn; backfill synthetic created event. Unblocks funnel/velocity/cohort | M | Core |
| 44 | **Funnel & stage-conversion report** | Pipedrive Deal Conversion | `getFunnel()` over "ever-reached-stage" sets; recharts funnel | M | Core |
| 45 | **Lead-source performance report** | monday/Nutshell; HubSpot/Pipedrive group-by-source | `groupBy(['source'])` `_sum(value)`/win-rate; `/analytics/sources` | M | Core |
| 46 | **First-touch vs last-touch attribution** | HubSpot's two simplest models | `model:'first'\|'last'` query branch; first-touch free from #17, last needs touch log | S/M | Core |
| 47 | **Deal velocity / time-in-stage** | Pipedrive Deal Duration | Stage durations from `DealStageEvent` deltas; stalled flag on Kanban | M | Core |
| 48 | **Win/loss + loss-reason capture** | Pipedrive Won/Lost conversion | `lossReason` enum on Deal; capture in `setDealStatus`; `groupBy`. Cheap, high signal | S/M | Core |
| 49 | **Pipeline cohort analysis** | monday/Monetizely (~1.5× target hit-rate) | Bucket by entry month via `$queryRaw`; heatmap table | L | Strategic Bet |
| 50 | **Multi-touch attribution + model selector** | HubSpot Revenue Attribution (linear/U/W/time-decay) | `Touchpoint` log + pure model fns; revenue-by-source-by-model | L | Strategic Bet |
| 51 | **UTM link builder + A/B experiment tracking** | Attribution best practice | Client-only link builder; `variant` field reuses source-perf aggregation | S/M | Strategic Bet |
| 52 | **Product analytics (usage/activation)** | Growth instrumentation | `UsageEvent` or gated PostHog behind server boundary; strictly org-scoped | M/L | Strategic Bet |
| 53 | **Slack notifications & deal alerts** | #1 popular marketplace category | Slack OAuth in `OrgIntegration`; emit from deal/stage actions. Best adoption-per-effort | S/M | Quick Win |
| 54 | **Two-way email sync (Gmail/Outlook)** | Most-cited table-stakes integration | `MailboxConnection` per-Membership + buy sync layer (Nylas/Unipile). **[backend: OAuth, worker]** | L | Core |
| 55 | **Calendar sync (Google/Microsoft)** | Standard in both leaders | `externalId`/`provider` on Activity; rides on #54's OAuth | M | Core |
| 56 | **Public REST API + webhooks + tokens** | Every serious CRM; unblocks ecosystem | `ApiToken` + `WebhookEndpoint`/`Delivery` outbox. **[backend: public API, webhooks]** | L | Strategic Bet |
| 57 | **Zapier + Make connectors** | "8,000+ apps" via config once API exists | Public app over the API (#56); near-zero marginal cost for Make | M | Strategic Bet |
| 58 | **Click-to-call + call logging** | Top-3 marketplace; Freshsales built-in | Aircall/JustCall embed + webhook → CALL Activity; not a from-scratch Twilio dialer | M | Core |
| 59 | **Accounting sync (QuickBooks/Xero)** | Finance category; sales-to-cash | Deal WON → draft invoice; Zapier path first, native later | M | Core |
| 60 | **Email-marketing sync (Mailchimp/Brevo)** | Top-3 marketplace category | Contact/tag sync via Zapier first; native if data shows pull | S/M | Quick Win |
| 61 | **Integrations directory (in-app)** | AppExchange/Marketplace surface | `OrgIntegration` table + connections dashboard; marketplace later | S | Quick Win |
| 62 | **OAuth app model (Smart-CRM as provider)** | Pipedrive/HubSpot/HighLevel platforms | `OAuthApp`/`OAuthGrant`; only after API+marketplace land. **[backend: security review]** | L | Strategic Bet |
| 63 | **Data enrichment (Apollo/Clearbit)** | Top marketplace category | "Enrich" button fills empty Company/Contact fields via provider API | M | Core |
| 64 | **AI assistant (Claude-powered)** | Zoho Zia / Freshsales Freddy / SF Einstein | Email draft/summarize, deal-risk summary, scoring assist, NL search. Ship earlier/lower than rivals | M/L | Strategic Bet |
| 65 | **No-code record/page designer (Zoho Canvas)** | Zoho Canvas, SF Lightning App Builder | Layout/config model + dynamic renderer. Defer | L | Strategic Bet |
| 66 | **Billing: plan/entitlement + Stripe + gating** | Every competitor gates by tier | `Plan`/`Subscription`/`Entitlement` + `requireFeature()`; Stripe Checkout/Portal; `<FeatureGate>`. **[backend: billing, webhooks]** | M–L | Core |

**66 features** in the de-duplicated gap table.

---

## 3. Competitive positioning

The two foundational structural gaps that every competitor flags and Smart-CRM lacks are
**multiple pipelines** (#2) and a **Lead object** (#4) — a single Kanban forces unrelated
motions into one funnel, and there's no holding area for unqualified inbound. Both map
almost directly onto the existing `PipelineStage`/`Deal` models and unblock honest
win-rate metrics and a real lead lifecycle. On top of these, **custom fields** (#1) are
the highest-leverage foundation: forms, scoring, reporting, and the automation "set
property" action all read/write them, and it's the first wall every team hits within
weeks.

Positioning choices distilled from the teardowns:
- **Be free where Pipedrive/Salesforce aren't.** A generous free 3-user tier (mirroring
  Zoho/Freshsales) is the acquisition wedge; withhold email-send, automation, and
  multi-pipeline to drive the Starter→Pro upgrade.
- **Be simple where HubSpot isn't.** Ship a **linear** (Pipedrive-style) automation
  builder, not a free-form graph — adequate for small teams and far cheaper to build.
- **Be AI-forward where everyone gates it.** Claude-powered drafting/summaries/NL-search
  shipped earlier and at a lower tier is the clearest differentiator (#64).
- **Pick a couple of premium differentiators to copy:** Zoho **Blueprint** (process+SLA,
  #38) builds directly on the pipeline; Freshsales-style **built-in telephony** (#58)
  wins phone-heavy verticals (agencies, real estate, home services).

---

## 4. Email & campaigns

Resend is the chosen transport and the runway is unusually short: `src/env.ts` already
validates `RESEND_API_KEY`/`EMAIL_FROM`, and the `Activity` model is a natural home for an
email timeline (add an `EMAIL` enum value). **Strategic decision: own the data model in
Postgres and use Resend purely as a send + webhook pipe** (path B) — for a multi-tenant
CRM, contacts/segmentation/reporting must live next to deals; Resend's hosted
Audiences/Broadcasts (path A) is only a faster MVP for the broadcast feature itself.

Dependency-aware build order (from the email brief):

1. **Foundation (#13, plus the `sendEmail()` primitive + `Suppression` model)** — Quick
   Wins, days not weeks. Transactional system emails (signup/reset/invite — NextAuth
   currently can't email) validate the whole pipe end-to-end.
2. **Core flagship loop: 1:1 tracked email (#5) + templates (#6) + open/click webhooks
   (#7).** This is the single highest-value sales feature — HubSpot-style email logged on
   the contact/deal timeline, made "smart" by tracking that also auto-handles
   bounces/complaints for deliverability.
3. **Compliance (#8)** — `List-Unsubscribe` one-click headers + suppression + physical
   address footer. **Non-optional gate before any bulk send** (Google/Yahoo require
   one-click unsubscribe for senders >5,000/day; CAN-SPAM/GDPR require honored opt-out).
4. **Engagement on dashboard/timeline** — cheap, high-visibility once tracking lands.
5. **Strategic bets that make it a platform: broadcast (#9) → A/B (#11) → sequences
   (#10).** Sends must be **queued and throttled to Resend's 2 req/s** via
   `/emails/batch` (100/req) with idempotency keys — design the sender as a rate-limited
   worker, not a loop. **[backend: job runner / scheduler]**
6. **Defer: visual builder (#12), inbound reply capture (#14)** — lean on React Email +
   Resend's hosted editor first; inbound needs MX/DNS setup.

Key platform dep: an email provider + domain/DKIM and a **public unauthenticated route**
for the tracking pixel/webhook **[backend: email infrastructure, webhook route]**.

---

## 5. Lead generation & capture

This is **the single biggest missing growth surface**: today records are created only by
an authenticated user manually filling a form — there is no path for a prospect on a
website to enter the CRM. The consistent competitor shape is
**Form/Chat → public capture endpoint → Lead object → dedup + scoring → convert to
Contact/Deal.** Build toward exactly that, in dependency order:

- **Lead object + Leads Inbox (#4)** is the keystone everything writes into — a
  `/leads` screen with unread leads visually flagged (Pipedrive blue-dot) and a "Convert"
  action that promotes a Lead into a Contact (+ optional Deal) in a transaction.
- **Form builder + embeddable form + `FormSubmission` (#15)** is the primary capture
  mechanism and **Smart-CRM's first public write endpoint** — a notable departure from
  the `requireOrg()`-gated norm. Ship it with **honeypot (#19), rate-limiting (#20), UTM
  capture (#17), and email-dedup (#22) in the same effort** so it launches safely.
  v1 is an iframe-hosted form (`/f/[formId]`) + `<script>` loader to dodge cross-origin
  CSS/CSP headaches. **[backend: public API, CORS, rate-limit]**
- **Rule-based lead scoring (#21)** turns raw capture into prioritized selling — fit
  (title/domain/company-size) + engagement (form/page) → Cold/Warm/Hot tiers via a pure,
  unit-testable `scoreLead()`. Predictive/AI scoring is explicitly out of scope for v1
  (needs training data Smart-CRM won't have early).
- **Then reach + depth:** hosted landing pages (#16), public Leads API (#23),
  full dedup+merge (#22), multi-step/progressive forms (#18, ~86% higher conversion),
  live-chat/chatbot (#24, bot-only first — **no realtime infra today**), and a
  meeting-scheduler card (#25) that books at peak intent into the existing `Activity`
  model.

Suggested order: **#4 → #15 (+19, +20, +17, +email-match slice of #22) → #21 → #16 → #23
→ full #22 → #18 → #24 → #25.** Cross-ref: forms/landing/scheduler all need a public
route and abuse controls **[backend: public API, rate-limiting]**.

---

## 6. Marketing automation & journeys

The repo is **already shaped for automation**: server actions centralize every write and
already call `revalidatePath`, so an `emitEvent(orgId, "deal.won", {...})` hook drops in
right after the DB write without scattering trigger logic. Tags (`Tag`/`ContactTag`) are a
ready-made segmentation primitive.

Natural trigger surfaces (already org-scoped): `contact.created/updated/tag_added`,
`deal.created/updated/stage_changed/won/lost`, `activity.created/completed`,
`company.created/updated`.

Phased delivery:
- **Phase 1 — make it real (internal-only, no external deps):** the **no-code linear
  workflow builder (#26)** (trigger → condition → action), **smart lists / dynamic
  segments (#27)** (the marketer's primary surface; its filter-expression engine is
  reused by workflow conditions), **task/notify actions (#31)** (the "create task" action
  is literally `createActivity` — maximum value, minimal new code), and **clone-and-go
  recipes (#33)**. This proves the model with zero external dependencies. **[backend:
  event bus + job runner + `Automation`/`Step`/`Run` models]**
- **Phase 2 — make it marketing:** **segment-change trigger (#28)** (turns segments into
  journeys — Customer.io's headline), **nurture journeys with delays (#29)**, **lifecycle
  automation (#3)**, **round-robin assignment (#30)**, recipe templates, and **run
  history (#34)** for trust.
- **Phase 3 — make it premium (paid-gating candidates):** **lead scoring (#21)**,
  **conditional branching + Goals (#32)** (HubSpot gates If/Then to Pro+), and **email
  send action (#5/#9)** — the gateway to "real" marketing automation, with mandatory
  consent/unsubscribe handling.

Ready-made recipes a small team wants on day one (all expressible with existing triggers):
Deal Won → onboarding task + lifecycle=Customer; New deal → first-touch task; Tag
`requested-demo` → MQL + notify + nurture; stale deal (no activity 7d) → re-engage task;
stage→Proposal Sent → wait 2 business days → check-in; new contact → round-robin +
welcome; enters "Cold Leads" segment → re-engagement journey with a Goal exit; missing
email → flag + notify.

---

## 7. Integrations & ecosystem

Integrations are a top adoption/retention lever, not a nice-to-have: Pipedrive's own data
shows businesses using integrations **win ~1.5× more deals** and close **~12% faster**;
HubSpot has 2,000+ apps / 2.5M+ installs. The repo is well-positioned — NextAuth's
`Account` model already stores `access_token`/`refresh_token`/`expires_at`/`scope` per
provider, so the OAuth plumbing for Google/Microsoft/Slack exists conceptually; the gaps
are per-**org** token storage, sync-state/external-ID mapping, a webhook outbox, and
public API tokens.

**Strategy: "native core, long-tail via Zapier."** Build deeply native the few
integrations on the daily critical path where quality _is_ the product; cover the
hundreds of niche apps via Zapier/Make + a public API + webhooks. Build-vs-buy meta-call:
**buy the email/calendar sync layer (Nylas/Unipile/Aurinko), build the CRM mapping** ("they
give the pipe, you build the pump"); start telephony as a **partner embed**
(Aircall/JustCall), not a from-scratch Twilio dialer.

Sequencing (waves):
1. **Daily-driver core + cheap wins:** **Slack (#53)** — the best adoption-per-effort win
   (#1 popular marketplace category, small surface, demos beautifully; emit from existing
   deal/stage actions); **native web form / Calendly (#15/#25)**; **two-way email sync
   (#54)** (start now — it's long); **calendar sync (#55)** (rides on #54's OAuth).
2. **Platform foundation:** **public API + webhooks (#56)** → unlocks **Zapier/Make (#57,
   "claim 8,000+ integrations")**, **Mailchimp/Brevo (#60)**, **QuickBooks/Xero (#59,
   via Zapier first)**, and the v1 **integrations directory (#61)**.
3. **Verticalized depth + ecosystem moat:** **telephony (#58)**, **PandaDoc e-sign (#41)**,
   **enrichment (#63)**, then the true **marketplace (#61) + OAuth app model (#62)**.

All of waves 2–3 lean on **[backend: public API, webhook outbox, OAuth/`OrgIntegration`
table]**.

---

## 8. Analytics & attribution

Two foundational instrumentation gaps block almost everything in this lens, and **order
matters**:

- **Source & UTM capture fields (#17)** — a tiny additive, all-nullable migration on
  Contact/Deal with **immutable first-touch** UTMs. Without stored source/UTM, no
  lead-source reporting or attribution is possible.
- **Stage-transition event log (#43)** — today `moveDealToStage`/`setDealStatus`
  **overwrite in place**, so time-in-stage, stage-to-stage conversion, and cohorts are
  literally uncomputable. One `DealStageEvent` table (appended in a `$transaction`, with a
  backfilled synthetic "created" event) turns on Pipedrive-grade analytics.

On that foundation, the Core analytics deliver immediate value: **funnel & stage-conversion
(#44)**, **lead-source performance — win rate & revenue by source (#45)**, **deal velocity
/ time-in-stage (#47)**, and **win/loss + loss-reason (#48, cheap, high signal)**. Then
**first-touch/last-touch attribution toggle (#46)** (first-touch is free from #17). The
Advanced differentiators sequence last: **multi-touch attribution with HubSpot-style model
selector (#50, linear / U-shaped 40-40-20 / W-shaped 30-30-30-10 / time-decay 7-day
half-life)**, **cohort analysis (#49)**, **UTM link builder + A/B experiment tracking
(#51)**, and **product/usage analytics for the CRM itself (#52)**.

Reuse the established idioms: `requireOrg()` + Zod + `ActionResult`; prefer Prisma
`groupBy`/`_count` over in-memory reduce for new aggregations; render with recharts as in
`pipeline-chart.tsx`. Guardrails: all reads strictly `orgId`-scoped, first-touch fields
immutable after first set, product-analytics must never cross tenants. Several reports
also depend on **[backend: reporting/analytics aggregation, stage-event log]**.

---

## 9. Pricing, packaging & monetization

**Competitor price comparison** (per seat/mo, annual) is in §1. Patterns: free tier is the
norm; entry clusters at $9–$15; the **mid tier ($23–$59) is the real revenue tier**; AI +
advanced automation are the top-tier levers; annual saves ~20–35%; add-ons (Pipedrive) and
usage billing (Freshsales telephony) supplement seat revenue.

**Recommended Smart-CRM tier structure** — a 4-tier ladder that undercuts Pipedrive while
matching Zoho/Freshsales value, fronted by a free wedge:

| Tier | Price (seat/mo, annual) | Target | Gated highlights | Key limits |
|---|---|---|---|---|
| **Free** | **$0** (up to 3 users) | Solo / trial | Contacts, companies, 1 pipeline, activities, basic dashboard, ⌘K search | 1,000 contacts; 1 pipeline; 2 saved views; no email/automation |
| **Starter** | **$15** | Small teams | Free + multiple pipelines, custom fields, 2-way email + templates + tracking, web forms, CSV import, saved views, reminders | 3 pipelines; 25 custom fields; 1 mailbox/user; 5 automations |
| **Professional** | **$39** | Growing teams | + Workflow automation, sequences, products & line items, report builder + goals, lead scoring, scheduler, API + webhooks, audit log | 15 pipelines; unlimited custom fields; 150 automations; 3 mailboxes |
| **Business** | **$69** | Scaling / multi-team | + Teams & territories, fine-grained permissions, SSO/SAML, recurring revenue/MRR, Smart Docs + eSign, advanced security, priority support | Unlimited; SSO; sandboxes; higher API quota |

Plus **add-ons** (à la Pipedrive's proven model, bundled free on Business): **Lead-gen
pack** (chatbot/prospector), **Telephony** (usage-billed via Twilio), **Email
marketing/Campaigns** (priced by contact volume).

**What's gated where (free-plan strategy):** the Free plan runs a tiny team but withholds
**email send, automation, and multi-pipeline** — the exact features that drive the
Starter→Pro upgrade. The **$39 Professional** tier (automation, sequences, reporting,
products, API) is the volume revenue driver; **teams/SSO/recurring-revenue/Smart-Docs**
are reserved for **$69 Business**.

**Monetization plumbing (#66):** a `Plan`/`Subscription`/`Entitlement` model keyed to
`Organization` with `requireFeature(key)` / `withinLimit(key, n)` helpers (Foundation);
**Stripe Checkout + Billing Portal + per-seat sync** (Core); a `<FeatureGate>` wrapper that
shows inline "Upgrade to Professional" prompts instead of erroring (Core); plan-limit
metering with **soft limits** that prompt upgrades rather than hard-block (Core); add-on
packaging; a no-card 14-day Pro trial; and annual/monthly toggle with Stripe-handled
proration/dunning. **[backend: billing/subscription, webhooks, jobs]**

---

## 10. Top 10 marketing/growth features (prioritized)

Sequenced for dependency order and impact — foundations and Quick Wins first, then the
flagship Core loop, then the platform bets.

1. **Custom fields (#1, Core/L).** The highest-leverage foundation — forms, scoring,
   reports, and automation "set property" all build on it; the first wall every team hits.
2. **Multiple pipelines + Lead object/Inbox (#2 + #4, Core/M).** The two biggest
   structural gaps vs. competitors; both map cleanly onto existing Deal/Stage models and
   unblock honest metrics + a real lead lifecycle.
3. **1:1 tracked email + templates + open/click tracking (#5+#6+#7, Core/M).** The
   flagship sales feature — HubSpot-style email logged on the timeline, made "smart" by
   tracking; gateway to sequences and scoring. Resend + `Activity` model already in place.
4. **Embeddable web forms → Lead (with honeypot, rate-limit, UTM, dedup) (#15, Core/L).**
   Closes the #1 growth gap — the first public path for prospects into the CRM; ship the
   safety rails in the same effort.
5. **Source & UTM capture + stage-transition event log (#17 + #43, Core/S+M).** The
   instrumentation foundation; without them, lead-source reporting, attribution, funnel,
   and velocity analytics are impossible.
6. **No-code workflow automation + recipes + task/notify actions (#26+#33+#31,
   Strategic/L).** Converts the CRM from system-of-record to system-of-action; the biggest
   "feels like a real CRM" gap; recipes drive day-one adoption.
7. **Rule-based lead scoring (#21, Core/M).** Turns raw capture into prioritized selling
   (Cold/Warm/Hot); the differentiator that elevates Smart-CRM from a form tool to a CRM.
8. **Slack notifications & deal alerts (#53, Quick Win/S–M).** Best adoption-per-effort
   integration — #1 marketplace category, tiny surface, demos beautifully.
9. **Funnel + lead-source + velocity + win/loss analytics (#44+#45+#47+#48, Core/M).**
   Pipedrive-grade reporting that answers "where do our best customers come from and where
   do deals stall" — a top reason teams move up tiers.
10. **AI assistant, Claude-powered (#64, Strategic/M–L).** Email drafting, deal-risk
    summaries, scoring assist, NL search — shipped **earlier and at a lower tier** than
    Zoho/Freshsales/Salesforce gate it; Smart-CRM's clearest differentiator.

_Quick-win starters to ship alongside (cheap, low/no dependencies):_ lifecycle stages
(#3), deal-rot badges + required-fields-per-stage (#35/#36), stage probability/weighted
pipeline (#37), dedupe/merge (#22), transactional system emails (#13), and the in-app
integrations directory (#61).

---

## 11. Recommended pricing & packaging summary

- **Lead with a free 3-user plan** (acquisition wedge; mirrors Zoho/Freshsales) — gives
  contacts, companies, one pipeline, activities, dashboard, and ⌘K, but **gates email
  send, automation, and multi-pipeline**.
- **Monetize the $39 Professional tier** as the volume revenue driver: workflow
  automation, sequences, products & line items, report builder + goals, lead scoring,
  scheduler, and public API + webhooks.
- **Reserve for $69 Business:** teams & territories, fine-grained permissions/SSO-SAML,
  recurring revenue/MRR, Smart Docs + e-signature, advanced security, priority support.
- **Add-ons (bundled free on Business):** lead-gen pack (chatbot/prospector), telephony
  (usage-billed), and email-marketing/campaigns (priced by contact volume).
- **Plumbing:** `Plan`/`Subscription`/`Entitlement` + `requireFeature()`/`withinLimit()`;
  Stripe Checkout/Portal with per-seat sync; `<FeatureGate>` upgrade prompts; soft usage
  limits; 14-day no-card Pro trial; annual (~20–30% off) vs monthly. **[backend:
  billing/subscription, webhooks, jobs]**

Net positioning: **undercut Pipedrive ($14/$39/$59) while matching Zoho/Freshsales value**,
win the free-tier acquisition game HubSpot/Zoho play, stay Pipedrive-simple on the sales
core, and differentiate with AI shipped earlier and lower than any competitor.
