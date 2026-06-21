# Smart-CRM — Email Marketing & Campaigns Research

**Author:** Marketing researcher (Email marketing & campaigns)
**Date:** 2026-06-20
**Scope:** Email templates, one-to-one tracked email, bulk/broadcast, drip sequences, open/click tracking, unsubscribe & compliance, A/B subject testing, email builder.

---

## Context: where Smart-CRM stands today

Read of the repo confirms the brief's "known gaps." There is **no email-sending code at all**, but the runway is unusually short:

- `src/env.ts` already validates `RESEND_API_KEY` and `EMAIL_FROM` (both optional). No new env plumbing needed to start.
- `package.json` has **no** `resend`, `react-email`, or `@react-email/components` dependency yet — these are the only meaningful adds.
- Server actions follow a tight, consistent pattern (`src/server/actions/*.ts`): `"use server"` → Zod `safeParse` → `requireOrg()` for tenancy → Prisma → `revalidatePath` → `ok()/fail()` from `src/lib/action-result.ts`. New email actions slot in identically.
- `requireOrg()` (`src/lib/tenant.ts`) returns `{ userId, orgId, role }`; `requireRole()` (`src/lib/rbac.ts`) gates by OWNER/ADMIN/MEMBER. Every new model must carry `orgId` and be scoped through these.
- The **`Activity` model** (`prisma/schema.prisma`) is the natural home for an email timeline: it already has `type` (enum `TASK|CALL|MEETING|NOTE`), `contactId`, `dealId`, `ownerId`, `body`. Adding an `EMAIL` enum value + linking sent emails makes one-to-one email show up on the contact/deal record for free.
- `Contact.email` exists and is indexed (`@@index([orgId, email])`), but there is **no consent/subscription state** on it — a compliance gap to close before any bulk send.
- Only one API route exists today (`src/app/api/auth/[...nextauth]/route.ts`). A webhook route (`src/app/api/webhooks/resend/route.ts`) is greenfield.

**What Resend gives us (confirmed):**
- **Transactional send** (`POST /emails`) and **batch** (`POST /emails/batch`, up to 100 per request). Rate limit **2 req/s** by default — bulk sends must be queued/throttled. ([Resend batch docs](https://resend.com/docs/api-reference/emails/send-batch-emails), [Knock benchmarks](https://knock.app/email-api-benchmarks/resend))
- **React Email** — author templates as JSX/React components, compiled to email-safe HTML; same render engine Resend is built on. ([Resend React Email](https://resend.com/docs/send-with-react), [dev.to guide](https://dev.to/blaise_tiong/how-to-send-emails-using-resend-and-react-email--1f78))
- **Broadcasts + Audiences + Contacts** — Resend has its own no-code broadcast editor, audiences, contact properties, and built-in open/click tracking + unsubscribe handling. ([Broadcasts](https://resend.com/features/broadcasts), [Broadcast API](https://resend.com/blog/broadcast-api), [Audiences](https://resend.com/features/audiences))
- **Webhooks (Svix-signed)** — 15 event types incl. `email.sent`, `email.delivered`, `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed`. Verify with `resend.webhooks.verify()` over the **raw** body + `svix-*` headers. ([Resend webhooks reference](https://github.com/resend/resend-skills/blob/main/skills/resend/references/webhooks.md), [Resend webhooks docs](https://resend.com/docs/webhooks/introduction))
- **Deliverability handled for you** — add a domain, Resend manages SPF/DKIM and provides DMARC guidance + an **automatic suppression list** for bounces/complaints. ([Managing Domains](https://resend.com/docs/dashboard/domains/introduction), [Email Authentication guide](https://resend.com/blog/email-authentication-a-developers-guide))
- **Idempotency keys** (`Idempotency-Key` header, 24h window) on `/emails` and `/emails/batch` — important for safe retries of bulk sends. ([Idempotency Keys](https://resend.com/docs/dashboard/emails/idempotency-keys))
- **Scheduled sends** (`scheduled_at`) for natively timed campaigns. ([Resend changelog](https://resend.com/changelog/idempotency-keys))

**Design decision that recurs below:** Resend offers two paths — (A) use Resend's hosted Audiences/Broadcasts and just sync, vs. (B) own the data model in our Postgres and use Resend purely as a send + webhook pipe. For a multi-tenant CRM where contacts, segmentation, and reporting must live next to deals, **path B is the strategic fit** (own the data; Resend is the transport). Path A is a faster MVP for the broadcast feature specifically.

---

## Idea 1 — Email-sending foundation (Resend client + transactional send + suppression)

**(1) Name & desc.** A shared `src/lib/email.ts` Resend client plus a single `sendEmail()` primitive every other feature builds on. Handles `from` (default `EMAIL_FROM`), reply-to, idempotency key, tagging (orgId, feature), and a **pre-send suppression check**. Not a user-facing feature — the bedrock.

**(2) Competitor/tool evidence.** Every platform (HubSpot, Mailchimp, Pipedrive) sits on a send engine + suppression list. Resend exposes exactly this: `POST /emails`, idempotency header, and an automatic suppression list for bounces/complaints. ([Resend email API](https://resend.com/features/email-api), [Idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), deliverability via [Managing Domains](https://resend.com/docs/dashboard/domains/introduction))

**(3) Fit with Smart-CRM.**
- *Deps:* add `resend` package. `RESEND_API_KEY`/`EMAIL_FROM` already in `src/env.ts`.
- *Schema:* `Suppression { id, orgId, email, reason (BOUNCE|COMPLAINT|MANUAL|UNSUBSCRIBE), createdAt, @@unique([orgId, email]) }`. Also a thin `EmailMessage` model (see Idea 2) to record sends.
- *Lib:* `src/lib/email.ts` exporting `getResend()` and `sendEmail({orgId, to, subject, react|html, idempotencyKey, tags})` that throws/returns early if `to` is suppressed for that org.
- *Resend use:* core. Tag every send with `orgId` so webhooks can be attributed.

**(4) Effort: S.** Deps: none beyond the package.

**(5) Tier: Quick Win** (gateway for everything else).

---

## Idea 2 — One-to-one tracked email from a Contact/Deal record

**(1) Name & desc.** A "Send email" action on the contact and deal detail pages. Compose subject + body, send via Resend, and **log it to the timeline** as an `Activity` of new type `EMAIL`. Opens/clicks (Idea 5) update that timeline entry. This is the single highest-value feature for a sales CRM — it's how reps actually use email day-to-day.

**(2) Competitor/tool evidence.** HubSpot's bread-and-butter: 1:1 emails tracked via pixel (opens) and redirect (clicks), logged on the contact record; click tracking noted as more reliable than open tracking. ([HubSpot email](https://www.hubspot.com/products/marketing/email), [HubSpot tracking guide](https://www.octavehq.com/post/hubspot-email-tracking-logging-setup-guide)) Pipedrive similarly logs sent email against the deal/person.

**(3) Fit with Smart-CRM.**
- *Schema:* `EmailMessage { id, orgId, contactId?, dealId?, fromUserId, toEmail, subject, bodyHtml, templateId?, resendId?, status (QUEUED|SENT|DELIVERED|OPENED|CLICKED|BOUNCED|COMPLAINED|FAILED), sentAt, lastEventAt, openCount, clickCount }` scoped by `orgId`. Add `EMAIL` to the `ActivityType` enum and link the activity to the message (or render the timeline directly from `EmailMessage`).
- *Server action:* `src/server/actions/email.ts` → `sendContactEmail(input)`: Zod-validate, `requireOrg()`, suppression check, `sendEmail()`, persist `EmailMessage` + create `Activity`, `revalidatePath('/contacts/[id]')`.
- *UI:* a "Send email" dialog on `src/app/(app)/contacts/[id]/page.tsx` and `deals/[id]`; a sent-email card in the existing "Recent activity" aside.
- *Resend use:* `POST /emails` with `tags:[{orgId},{messageId}]` so webhooks map back to the row.

**(4) Effort: M.** Deps: Idea 1; Idea 4 (templates) optional but pairs well.

**(5) Tier: Core** (arguably the flagship — do early).

---

## Idea 3 — Reusable email templates (saved snippets + React Email layouts)

**(1) Name & desc.** An org-scoped `Template` library: named, reusable subject+body with **merge variables** (`{{firstName}}`, `{{companyName}}`, `{{deal.title}}`). Used by one-to-one send, sequences, and broadcasts. Two layers: (a) user-editable content templates stored in DB; (b) a small set of React Email *layout* wrappers (header/footer/branding) for consistent rendering.

**(2) Competitor/tool evidence.** HubSpot ships a library of "data-backed," goal-based templates and lets reps personalize per enrollment. Mailchimp has 100+ templates + merge tags (`*|FNAME|*`) for personalization. ([HubSpot templates](https://blog.hubspot.com/sales/100k-email-templates-follow-up), [Mailchimp merge tags](https://mailchimp.com/help/all-the-merge-tags-cheat-sheet/)) Resend's own templates let `from/subject/reply_to` in the payload override template defaults — confirming the merge/override pattern. ([Resend send-batch docs](https://resend.com/docs/api-reference/emails/send-batch-emails))

**(3) Fit with Smart-CRM.**
- *Schema:* `Template { id, orgId, name, subject, bodyHtml, category?, createdBy, updatedAt, @@index([orgId, name]) }`.
- *Lib:* `src/lib/merge.ts` — safe `{{var}}` substitution against a typed context built from Contact/Company/Deal; React Email layout components under `src/emails/`.
- *Server actions:* `src/server/actions/templates.ts` (CRUD), mirroring `contacts.ts` exactly.
- *UI:* `src/app/(app)/settings/templates` (list/create/edit) + a template picker in the send dialog.
- *Resend use:* render template → HTML at send time (React Email or our own merge); Resend just transports.

**(4) Effort: M.** Deps: light; standalone but multiplies value of Ideas 2/6/7.

**(5) Tier: Core.**

---

## Idea 4 — Open & click tracking via Resend webhooks

**(1) Name & desc.** A signed webhook endpoint that ingests Resend email events and updates `EmailMessage` rows: mark delivered/opened/clicked, increment counts, set `lastEventAt`, and **auto-add bounces/complaints to the suppression list**. This is what makes every other email feature "smart."

**(2) Competitor/tool evidence.** Universal table stakes. Pipedrive Campaigns reports open rate, click rate, total/unique clicks, CTR, and surfaces unsubscribes/spam in the campaign report; HubSpot tracks opens (pixel) + clicks (redirect). ([Pipedrive analytics](https://www.pipedrive.com/en/products/email-marketing-software/email-analytics)) Resend exposes the events directly: `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, etc., Svix-signed. Best practice: hard bounce → remove immediately; complaint → immediate suppression, no exceptions; dedupe by event id; return 200 within ~5s. ([Resend webhooks reference](https://github.com/resend/resend-skills/blob/main/skills/resend/references/webhooks.md), [event-handling best practices](https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/webhooks-events.md))

**(3) Fit with Smart-CRM.**
- *Deps:* add `RESEND_WEBHOOK_SECRET` to `src/env.ts`; `resend` package (has `webhooks.verify`).
- *Route:* `src/app/api/webhooks/resend/route.ts` — read **raw** body, verify Svix headers, map `data.tags`/`email_id`→`EmailMessage`, upsert event (idempotent on Svix message id), update status/counts; on bounce/complaint write `Suppression`.
- *Schema:* optional `EmailEvent { id (svix id), messageId, type, payload Json, createdAt }` for an auditable raw log + dedupe.
- *Resend use:* core — this is the inbound half of the pipe.
- *Caveat:* note the open-pixel reliability limitation (image blocking) in any UI that shows open rate, per HubSpot guidance.

**(4) Effort: M.** Deps: Ideas 1–2.

**(5) Tier: Core.**

---

## Idea 5 — Unsubscribe management & compliance (suppression, one-click, consent)

**(1) Name & desc.** Subscription state on contacts + a public unsubscribe page + `List-Unsubscribe` / `List-Unsubscribe-Post` headers on every marketing send, plus a campaign footer with the legally required physical address. Every bulk send filters against suppression + unsubscribed contacts. **This is a prerequisite for bulk/drip — not optional.**

**(2) Competitor/tool evidence.** CAN-SPAM requires a working opt-out honored within 10 business days + a physical mailing address; GDPR requires withdrawing consent be as easy as giving it; **Google/Yahoo require one-click unsubscribe (`List-Unsubscribe` header) for senders >5,000/day and honoring within ~2 days**. Pipedrive surfaces subscribed/unsubscribed state to "stay fully compliant with GDPR." ([One-click unsubscribe requirement](https://powerdmarc.com/one-click-unsubscribe-email-requirement/), [unsubscribe law](https://campaignrefinery.com/email-unsubscribe-law/), [Pipedrive segmentation/compliance](https://www.pipedrive.com/en/products/email-marketing-software/segmentation))

**(3) Fit with Smart-CRM.**
- *Schema:* add to `Contact`: `subscriptionStatus (SUBSCRIBED|UNSUBSCRIBED|PENDING)` + `unsubscribedAt?`. `Suppression` from Idea 1. Org-level `marketingFromAddress` + `marketingPhysicalAddress` on `Organization` for the footer.
- *Route:* public `src/app/unsubscribe/[token]/route.ts` (signed token → set status, honor `List-Unsubscribe-Post` for one-click).
- *Lib:* helper to inject `List-Unsubscribe` + `List-Unsubscribe-Post` headers and the compliance footer into marketing sends only (transactional 1:1 stays clean).
- *Resend use:* set headers in `POST /emails`; rely on Resend's suppression as a second safety net.

**(4) Effort: M.** Deps: Idea 1 (suppression), needed before Ideas 6/7 ship to real audiences.

**(5) Tier: Core** (compliance gate).

---

## Idea 6 — Bulk / broadcast email to a contact segment

**(1) Name & desc.** Select a segment (by tag, company, or filter), pick a template, preview, and send a one-off campaign. Sends are **queued and throttled** to respect Resend's 2 req/s, batched via `/emails/batch`, each personalized with merge vars; results roll up into per-campaign analytics (sent/delivered/opened/clicked/bounced/unsubscribed).

**(2) Competitor/tool evidence.** Pipedrive Campaigns = templates + drag-drop builder + segmentation + analytics, built into the CRM; Mailchimp's "Regular" campaign is the canonical model. ([Pipedrive Campaigns](https://www.pipedrive.com/en/products/email-marketing-software), [Mailchimp overview](https://automationatlas.io/answers/what-is-mailchimp/)) Resend supports this two ways: hosted **Broadcasts/Audiences** (faster MVP) or self-owned via **batch send** (100/req) + scheduling. ([Broadcast API](https://resend.com/blog/broadcast-api), [batch docs](https://resend.com/docs/api-reference/emails/send-batch-emails))

**(3) Fit with Smart-CRM.**
- *Schema:* `Campaign { id, orgId, name, subject, templateId|bodyHtml, status (DRAFT|SCHEDULED|SENDING|SENT), scheduledAt?, segmentJson, stats..., createdBy }` and `CampaignRecipient { id, campaignId, contactId, emailMessageId?, status }`. Reuse `EmailMessage`/webhooks for per-recipient events.
- *Server actions:* `src/server/actions/campaigns.ts` — create/schedule/send; a queue/cron (e.g., Vercel cron or a `pending` poller) drains recipients in batches with idempotency keys. Gate behind `requireRole(ADMIN)`.
- *UI:* `src/app/(app)/campaigns` — list, builder (reuse segment filters from `contacts` list + `search.ts`), preview, report page.
- *Resend use:* `/emails/batch` + idempotency + `scheduled_at`; **must** filter against Idea 5 suppression/unsubscribe first.
- *Throttle note:* 2 req/s is the hard constraint — design the sender as a rate-limited worker, not a loop.

**(4) Effort: L.** Deps: Ideas 1, 3, 4, 5 (and a job runner).

**(5) Tier: Strategic Bet.**

---

## Idea 7 — Drip campaigns / multi-step sequences

**(1) Name & desc.** Author an ordered series of steps (email → wait N days → email…), enroll a contact (manually, or auto on tag/stage change), and advance enrollments on a schedule. Stop-on-reply / stop-on-unsubscribe rules. Turns Smart-CRM from a record-keeper into an automation engine.

**(2) Competitor/tool evidence.** HubSpot Sequences (1:1, personalizable per enrollment, records sends/opens/clicks/replies/meetings); Mailchimp Customer Journeys (triggers, delays, conditions, branching: welcome series, re-engagement). ([HubSpot sequences](https://simplestrat.com/blog/hubspot-sequences), [Mailchimp automations](https://mailchimp.com/features/automations/marketing-automation-flows/))

**(3) Fit with Smart-CRM.**
- *Schema:* `Sequence { id, orgId, name, status }`, `SequenceStep { id, sequenceId, order, templateId, delayDays }`, `SequenceEnrollment { id, sequenceId, contactId, currentStep, status (ACTIVE|PAUSED|COMPLETED|STOPPED), nextRunAt }`.
- *Server actions:* `src/server/actions/sequences.ts` (author/enroll); a scheduled worker queries `nextRunAt <= now`, sends the step via Idea 2/3, advances or stops (honor unsubscribe/suppression/reply).
- *UI:* `src/app/(app)/sequences` builder + enrollment view on the contact record.
- *Resend use:* per-step transactional sends + webhook events; same throttling discipline as Idea 6.
- *Triggers* can later hook into existing deal stage changes (`deals.ts`) for automation.

**(4) Effort: L.** Deps: Ideas 2, 3, 4, 5 + reliable scheduler.

**(5) Tier: Strategic Bet.**

---

## Idea 8 — A/B subject-line testing

**(1) Name & desc.** For a campaign (Idea 6), define subject variants A/B; send to an equal split (optionally a small test slice first), measure open rate, and auto-send the winner to the remainder.

**(2) Competitor/tool evidence.** HubSpot A/B auto-splits sends evenly and records sends/opens/clicks/replies per variant; Mailchimp A/B tests subject lines, send times, content. ([HubSpot A/B](https://knowledge.hubspot.com/marketing-email/run-an-a/b-test-on-your-marketing-email), [Mailchimp campaign types](https://automationatlas.io/answers/what-is-mailchimp/))

**(3) Fit with Smart-CRM.**
- *Schema:* extend `Campaign` with `variantOf?`/`abGroup` or a `CampaignVariant { id, campaignId, label, subject, weight, stats }`; assign each `CampaignRecipient` a variant.
- *Server action:* split recipients deterministically, send per variant, compute winner from webhook opens (note open-tracking reliability caveat), optionally send winner to a holdout.
- *UI:* variant editor in the campaign builder + side-by-side results.
- *Resend use:* same batch send; only subject differs per group.

**(4) Effort: M** (on top of Idea 6). Deps: Ideas 6, 4.

**(5) Tier: Strategic Bet** (depends on bulk being live).

---

## Idea 9 — Drag-and-drop / block email builder

**(1) Name & desc.** A visual editor (text/image/button/divider blocks) producing email-safe HTML, so non-technical users design branded emails without touching code. Output feeds templates, campaigns, and sequences.

**(2) Competitor/tool evidence.** Pipedrive and Mailchimp both center a no-code drag-and-drop builder (Mailchimp 100+ templates; Pipedrive: pick fonts, import HTML, embed gifs/social links, no coding). ([Pipedrive builder](https://www.pipedrive.com/en/products/email-marketing-software), [Mailchimp builder](https://www.gmass.co/blog/mailchimp-reviews/)) Resend's hosted Broadcasts also include a no-code editor we could lean on for v1. ([Broadcasts](https://resend.com/features/broadcasts))

**(3) Fit with Smart-CRM.**
- *Schema:* store builder output as `bodyJson` (block tree) alongside compiled `bodyHtml` on `Template`/`Campaign`.
- *Lib:* a JSON-blocks → React Email/HTML compiler under `src/emails/`.
- *UI:* a new editor component (shadcn + dnd-kit is already a dep — reuse the Kanban drag infra).
- *Resend use:* renders to HTML; transport unchanged. **Caveat:** building a robust, email-client-safe WYSIWYG is genuinely large — strongly prefer starting with React Email templates (Idea 3) or Resend's hosted broadcast editor, and treat this as a later polish.

**(4) Effort: L.** Deps: Idea 3.

**(5) Tier: Strategic Bet** (lowest priority; consider deferring to Resend's hosted editor first).

---

## Idea 10 — Email engagement on the Dashboard & contact timeline

**(1) Name & desc.** Surface email signals where reps already look: an "Email" filter/section in the contact/deal timeline (from `EmailMessage`), and dashboard widgets for sent/open/click rates and recent campaign performance. Closes the loop — data captured in Idea 4 becomes actionable.

**(2) Competitor/tool evidence.** Pipedrive's real-time analytics (open/click/CTR/unique clicks) and HubSpot's per-contact engagement history are core to adoption; Resend itself added a per-contact activity timeline (created/unsubscribed/received). ([Pipedrive analytics](https://www.pipedrive.com/en/products/email-marketing-software/email-analytics), [Resend contacts experience](https://resend.com/blog/new-contacts-experience))

**(3) Fit with Smart-CRM.**
- *Schema:* none new — aggregates over `EmailMessage`/`Campaign` stats.
- *UI:* extend `src/app/(app)/dashboard` (already uses `recharts`) with open/click rate cards; add an email tab to the contact/deal timeline already rendered on the detail pages.
- *Server:* read-only aggregate queries scoped by `requireOrg()`.

**(4) Effort: S–M.** Deps: Ideas 2 & 4.

**(5) Tier: Quick Win** (once tracking exists).

---

## Idea 11 — Transactional system emails (auth & notifications)

**(1) Name & desc.** Wire Resend into existing flows that currently have *no* email: signup verification / welcome, password reset, team invite, and activity/task due reminders. Lower marketing value but it's the cheapest way to validate the whole Resend pipeline end-to-end and immediately useful (NextAuth invites currently can't email).

**(2) Competitor/tool evidence.** Resend's primary use case; transactional = system-triggered (verification, resets, invites) vs. scheduled marketing. ([Resend transactional vs broadcast](https://xmit.sh/alternatives/resend), [Encore tutorial](https://encore.dev/blog/resend-tutorial))

**(3) Fit with Smart-CRM.**
- *Schema:* none (reuses `VerificationToken`); optionally log to `EmailMessage`.
- *Server:* call `sendEmail()` (Idea 1) from `src/server/actions/auth.ts` / `org.ts` (invites). NextAuth v5 email provider can use the same client.
- *Resend use:* `POST /emails` with React Email templates; **no** `List-Unsubscribe` (transactional, not marketing).

**(4) Effort: S.** Deps: Idea 1.

**(5) Tier: Quick Win.**

---

## Idea 12 — Inbound reply capture & two-way threading (forward-looking)

**(1) Name & desc.** Use Resend **inbound** (`email.received`) so replies to tracked 1:1 emails land back on the contact timeline, enabling stop-on-reply for sequences and a basic shared inbox feel.

**(2) Competitor/tool evidence.** HubSpot/Pipedrive log replies and book meetings off them; HubSpot sequences explicitly stop on reply. Resend supports inbound receiving with `email.received` (fetch body via `resend.emails.receiving.get()`). ([HubSpot sequences](https://simplestrat.com/blog/hubspot-sequences), [Resend webhooks reference](https://github.com/resend/resend-skills/blob/main/skills/resend/references/webhooks.md))

**(3) Fit with Smart-CRM.**
- *Deps:* inbound MX on a send subdomain (Resend setup), reply-address routing (plus-addressing to encode message/contact id).
- *Schema:* extend `EmailMessage` with `direction (OUTBOUND|INBOUND)` + `inReplyTo`.
- *Route:* extend the webhook route to handle `email.received`; thread on the contact.
- *Resend use:* inbound parsing + fetch body.

**(4) Effort: L.** Deps: Ideas 2, 4 + DNS/inbound setup.

**(5) Tier: Strategic Bet** (later; unlocks true two-way and reliable stop-on-reply).

---

## Suggested build order (dependency-aware)

1. **Idea 1** (foundation) → **Idea 11** (transactional, validates the pipe) — both Quick Wins, days not weeks.
2. **Idea 2** (1:1 tracked email) + **Idea 3** (templates) + **Idea 4** (webhooks/tracking) — the Core flagship loop.
3. **Idea 5** (compliance) — gate before any bulk.
4. **Idea 10** (dashboard/timeline) — cheap, high-visibility once tracking lands.
5. **Idea 6** (broadcast) → **Idea 8** (A/B) → **Idea 7** (sequences) — the Strategic Bets that make it a platform.
6. **Idea 9** (visual builder) / **Idea 12** (inbound) — defer; lean on React Email + Resend hosted editor first.

---

## Top 3 picks

1. **One-to-one tracked email from a record (Idea 2)** — the flagship sales-CRM feature; pairs with templates (3) and tracking (4) to deliver HubSpot-style 1:1 email logged on the contact/deal timeline. Highest value-to-effort given Resend + `Activity` model are already in place.
2. **Open/click tracking via Resend webhooks + suppression (Idea 4, with Idea 1 foundation)** — makes every email "smart," powers all analytics, and auto-handles bounces/complaints for deliverability. The capability that differentiates a CRM from a mail-merge tool.
3. **Bulk/broadcast email to a segment with compliance built in (Ideas 6 + 5)** — the marketing centerpiece (segment → template → send → report), with one-click unsubscribe and suppression that keep Smart-CRM Google/Yahoo- and CAN-SPAM/GDPR-compliant from day one.

---

### Sources
- Resend Broadcasts — https://resend.com/features/broadcasts
- Resend Broadcast API — https://resend.com/blog/broadcast-api
- Resend Audiences — https://resend.com/features/audiences
- Resend Managing Contacts — https://resend.com/docs/dashboard/audiences/contacts
- Resend webhooks reference (events, payloads, Svix verify) — https://github.com/resend/resend-skills/blob/main/skills/resend/references/webhooks.md
- Resend event-handling best practices (bounces/complaints/idempotency) — https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/webhooks-events.md
- Resend Webhooks docs — https://resend.com/docs/webhooks/introduction
- Resend Send Batch Emails (100/req, template overrides) — https://resend.com/docs/api-reference/emails/send-batch-emails
- Resend React Email — https://resend.com/docs/send-with-react and https://dev.to/blaise_tiong/how-to-send-emails-using-resend-and-react-email--1f78
- Resend Idempotency Keys — https://resend.com/docs/dashboard/emails/idempotency-keys
- Resend Managing Domains (SPF/DKIM/DMARC, suppression) — https://resend.com/docs/dashboard/domains/introduction
- Resend Email Authentication guide — https://resend.com/blog/email-authentication-a-developers-guide
- Resend rate-limit / benchmarks — https://knock.app/email-api-benchmarks/resend
- HubSpot Email Marketing — https://www.hubspot.com/products/marketing/email
- HubSpot A/B testing — https://knowledge.hubspot.com/marketing-email/run-an-a/b-test-on-your-marketing-email
- HubSpot Sequences — https://simplestrat.com/blog/hubspot-sequences
- HubSpot tracking/logging — https://www.octavehq.com/post/hubspot-email-tracking-logging-setup-guide
- Pipedrive Campaigns — https://www.pipedrive.com/en/products/email-marketing-software
- Pipedrive Segmentation — https://www.pipedrive.com/en/products/email-marketing-software/segmentation
- Pipedrive Email Analytics — https://www.pipedrive.com/en/products/email-marketing-software/email-analytics
- Mailchimp overview/automations — https://automationatlas.io/answers/what-is-mailchimp/ and https://mailchimp.com/features/automations/marketing-automation-flows/
- Mailchimp merge tags — https://mailchimp.com/help/all-the-merge-tags-cheat-sheet/
- One-click unsubscribe requirement (Google/Yahoo) — https://powerdmarc.com/one-click-unsubscribe-email-requirement/
- Email unsubscribe law (CAN-SPAM/GDPR) — https://campaignrefinery.com/email-unsubscribe-law/
