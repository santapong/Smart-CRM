# Smart-CRM — Email Infrastructure Design Brief

**Author:** Backend/Platform Engineering · **Date:** 2026-06-20
**Scope:** The email PLUMBING — transactional + bulk send, React Email templating, inbound parsing & threading to CRM records, open/click tracking, bounce/complaint suppression, per-tenant sending domains, and the data model. Product/marketing own the FEATURES; this brief owns the backbone.

---

## 0. Context & Constraints (read first)

**Stack today** (`src/env.ts`, `prisma/schema.prisma`, `package.json`):
- Next.js 15 (App Router, RSC), Prisma 5.22, Postgres 16, NextAuth v5, deployed on **Vercel**.
- `RESEND_API_KEY` + `EMAIL_FROM` are **already declared** in `src/env.ts` (both `.optional()`) but **no email code exists** — zero templates, zero tracking, zero inbound.
- Multi-tenant pattern is uniform: every domain row carries `orgId`, FK `onDelete: Cascade` to `Organization`, scoped via `requireOrg()` (`src/lib/tenant.ts`) and RBAC ranks OWNER>ADMIN>MEMBER (`src/lib/rbac.ts`). IDs are `cuid()`; long text uses `@db.Text`.
- **No queue/jobs system exists** (no BullMQ, Inngest, QStash, or cron in deps). Bulk send and async webhook processing both depend on introducing one. This is the single biggest cross-cutting dependency in this brief.

**Serverless constraints that shape every decision:**
- Vercel functions are **ephemeral and time-boxed** (Hobby ~10s, Pro default 15s, configurable up to 300s on Fluid/Node; background work beyond the response is not guaranteed). You **cannot** hold a process to drip thousands of emails or do in-memory retry loops. Long/bulk work must be **externalized to a queue/scheduler** that calls back via HTTP. [Vercel functions]
- Webhook handlers must **ack fast (2xx within ~5s) and process async** — Resend retries with exponential backoff for ~24h; Postmark retries 10× and **stops on 403**. [Resend best-practices], [Postmark inbound]
- **Raw body required** for signature verification — Next.js route handlers must read `await req.text()` (not `req.json()`), because parsing invalidates the Svix/HMAC signature. [Resend webhooks]

**Provider stance:** Build on **Resend** (pre-wired, best DX, React Email native, and as of Nov 2025 it has first-party **Inbound** receiving — so the whole send+receive loop lives with one vendor). Wrap all provider calls behind a thin `EmailProvider` interface so **Postmark** (best deliverability, mature inbound) or **SES** (cheapest at scale) can be swapped in per-tenant or as a fallback. See §A and the provider comparison in §9.

---

## A. Transactional Sending + Provider Abstraction
**(1) What it enables:** A single internal API to send one-off system emails (invites, password resets, deal/activity notifications, "email this contact") reliably, with a swappable provider so Smart-CRM is never vendor-locked.

**(2) Design**

Thin port + Resend adapter (`src/lib/email/provider.ts`):
```ts
export interface SendEmailInput {
  orgId: string;
  to: string | string[];
  from?: string;            // defaults to tenant sending domain (§G) or EMAIL_FROM
  subject: string;
  html?: string;
  react?: React.ReactElement; // React Email (§B)
  replyTo?: string;
  headers?: Record<string,string>; // Message-ID / References for threading (§D)
  tags?: { name: string; value: string }[]; // carry orgId + emailMessageId for webhook correlation
  idempotencyKey?: string;  // dedupe retried sends
}
export interface EmailProvider {
  send(i: SendEmailInput): Promise<{ providerMessageId: string }>;
  sendBatch(items: SendEmailInput[]): Promise<{ providerMessageId: string }[]>;
}
```
- **Resend adapter** uses the official `resend` SDK (`resend.emails.send`). Pass an `Idempotency-Key` so a retried Vercel invocation never double-sends (keys ≤256 chars, unique per request). [Resend idempotency]
- Every send writes an `EmailMessage` row (§H) in status `QUEUED`/`SENT` **before/at** the API call, storing the returned `providerMessageId` — this is the join key for all later webhook events.
- `from` resolves to the tenant's verified sending domain (§G); fall back to global `EMAIL_FROM`. Inject `tags: [{name:"orgId",value:orgId},{name:"emsg",value:emailMessage.id}]` so tracking webhooks (§E) can attribute events even if `providerMessageId` lookup races.
- Guard at the edge: refuse to send to any address on the tenant **Suppression** list (§F) — check happens in the send service, not the route.

**(3) Reference evidence**
- Resend rate limit is **2 requests/second** by default across all endpoints; respects `ratelimit-*` response headers; request more if needed. [Resend rate limit]
- Idempotency keys prevent duplicate sends on retry, ≤256 chars, unique per request. [Resend idempotency keys]

**(4) Effort: S** · Deps: `resend` SDK; Suppression (§F) for the pre-send check.

**(5) Tier: Foundation** — everything else builds on this.

---

## B. React Email Templating
**(1) What it enables:** Versioned, branded, responsive email templates authored as React components (not hand-tooled table HTML), rendered to HTML+plaintext at send time, with per-tenant variables (logo, colors, signature) and merge fields (contact name, deal title).

**(2) Design**
- Add `@react-email/components` + `@react-email/render`. Templates live in `src/emails/*.tsx` (e.g. `ContactReplyNotification.tsx`, `DealStageChanged.tsx`, `Invite.tsx`).
- Two authoring modes:
  - **Code templates** (developer-owned, type-safe props) — preferred for system mail. Resend accepts a `react` field directly, or call `render(<Template {...props}/>)` to get HTML and `render(<Template/>, {plainText:true})` for the text part.
  - **Tenant-editable templates** (marketing/CRM users) — stored as a `Template` row (§H) with an HTML/MJML body + a small allow-listed variable set; rendered with a sandboxed string interpolator (e.g. handlebars-style) — **never** `eval`. Keep code and user templates as distinct `Template.kind` values.
- Always send **multipart** (HTML + generated plaintext) — improves deliverability and accessibility.
- Provide a `/dev` preview route (gated to non-prod) using `react-email` preview server for fast iteration.

**(3) Reference evidence**
- Resend has deep first-party React Email integration; components compile to email-friendly HTML before sending. [Resend × React Email]

**(4) Effort: M** · Deps: A (provider), H (Template model).

**(5) Tier: Core.**

---

## C. Bulk / Batch Sending Within Rate Limits
**(1) What it enables:** Send to many recipients (a segment, a deal list) without tripping the 2 req/s limit or serverless timeouts — e.g. an org emails 5,000 contacts and each gets an `EmailMessage` row, suppression-checked, tracked.

**(2) Design** — *this is the queue-dependent capability.*
- **Fan-out, don't loop in-request.** A bulk send creates a parent `EmailCampaign`/job record + N `EmailMessage` rows in `QUEUED`, then enqueues work to an external scheduler.
- **Recommended queue: Upstash QStash** for v1 — HTTP-native (POST a message → it calls your endpoint back with retries + scheduling), serverless-perfect, ~$1/100K msgs, no infra. Upgrade path to **Inngest** if multi-step workflows/durable orchestration are needed later. [QStash vs Inngest]
- **Chunking + pacing:** Use Resend's **batch endpoint = up to 100 emails per request**. The worker pulls a chunk of ≤100 `QUEUED` rows, calls `sendBatch`, and is itself paced to ≤2 req/s (QStash `flowControl`/rate or a token-bucket keyed in Postgres/Redis). Pass a **per-batch idempotency key** so a retried chunk never re-sends. [Resend batch], [Resend batch idempotency]
- **Backpressure:** honor `429` + `ratelimit-reset` by re-enqueuing the chunk with delay. Mark rows `SENT` only on provider 2xx; failures → `FAILED` with error captured for retry/inspection.
- **Suppression filter** runs at enqueue AND at send (list may grow mid-campaign).

**(3) Reference evidence**
- Batch endpoint sends **up to 100 emails per call**; supports idempotency keys. [Resend batch], [Resend batch idempotency]
- Default **2 req/s**; introduce a queue / reduce concurrency to avoid throttling. [Resend rate limit]
- QStash is the simplest serverless queue ($1/100K), delivers HTTP with retries + scheduling; Inngest for durable multi-step workflows. [QStash vs Inngest]

**(4) Effort: L** · Deps: A, F (suppression), H (EmailMessage + campaign), and a **queue/scheduler decision (QStash)** — gating dependency.

**(5) Tier: Strategic Bet** — high value, but the queue introduces real operational surface.

---

## D. Threading Replies to the Right Contact/Deal
**(1) What it enables:** When a contact replies, the message is logged on the correct `Contact`/`Deal` and stitched into the existing conversation thread — the core "CRM logs your email" behavior.

**(2) Design** — two complementary correlation strategies:
- **RFC threading (primary):** On every outbound send, set/record `Message-ID`. Persist it on `EmailMessage.messageId`. Inbound replies carry `In-Reply-To` and `References` headers — match those against stored `messageId`s to find the parent and reuse its `EmailThread`. (Resend lets you set custom `headers`; Postmark exposes `Headers` incl. `Message-ID`/`In-Reply-To`/`References`, plus a `messageIdFromHeaders` helper.) [Resend webhooks], [Postmark inbound]
- **Plus-addressing (robust fallback):** Send with `Reply-To: reply+<threadToken>@inbound.smartcrm.app`. On inbound, the token after `+` arrives in Postmark's `MailboxHash` (or is parsed from the Resend `to`), giving an exact `EmailThread` id even when clients strip `References`. [Postmark MailboxHash]
- **Resolution order:** (1) plus-address token → thread; else (2) `In-Reply-To`/`References` → parent message → thread; else (3) match sender email to a `Contact` in the tenant (scope by the inbound domain → org) and open a **new** thread. Unmatched senders → an "unassigned inbound" queue for manual triage.
- Store the parsed reply as an `EmailMessage` (`direction: INBOUND`) linked to `threadId`, `contactId`, `dealId`, and surface it as an `Activity` (type `NOTE`/new `EMAIL`) so it shows on the contact/deal timeline.

**(3) Reference evidence**
- Postmark inbound JSON includes `Headers` (Message-ID, In-Reply-To, References), `StrippedTextReply` (quote-stripped reply body, populated only when In-Reply-To/References present), and `MailboxHash` from `user+hash@` plus-addressing — explicitly recommended for matching replies to a thread. [Postmark inbound], [Postmark MailboxHash]
- Resend inbound exposes full headers via `resend.emails.receiving.get()`. [Resend webhooks]

**(4) Effort: M** · Deps: E1 inbound (§E2), H (EmailMessage/EmailThread), existing `Contact`/`Deal`/`Activity`.

**(5) Tier: Core** — the defining CRM email value.

---

## E. Inbound Email Parsing & Routing
**(1) What it enables:** A tenant-specific inbound address (e.g. `<org-slug>@inbound.smartcrm.app` or `reply+<token>@…`) that receives replies/forwards, parses them to JSON, and routes into threading (§D).

**(2) Design**
- **Resend Inbound** (GA Nov 2025): point an MX/inbound domain at Resend, subscribe to `email.received`. Webhook payload is **metadata only** (`email_id`, `from`, `to`, `subject`, `attachments`); fetch full content (html/text/headers) via `resend.emails.receiving.get(email_id)`. Resend **stores inbound even if the webhook is down**, so no data loss during deploys/outages. [Resend inbound], [Resend webhooks]
- **Route handler** `src/app/api/email/inbound/route.ts` (Node runtime): read raw body → **verify Svix signature** → ack `2xx` immediately → enqueue parse+route job (QStash) → worker fetches content, runs §D resolution, writes `EmailMessage`+`Activity`, stores attachments to blob storage (Vercel Blob/S3), records refs.
- **Tenant mapping:** derive `orgId` from the inbound recipient (per-tenant subdomain/local-part or the plus-token), so multi-tenant routing is deterministic.
- **Alternative provider:** Postmark inbound is the mature option — JSON includes parsed `TextBody`/`HtmlBody`/`StrippedTextReply`/`Attachments` **inline** (no second fetch) and the `MailboxHash`; good fallback if Resend Inbound limits bite. SES inbound (SNS→Lambda/S3) is cheapest but you parse MIME yourself — most work. [Postmark inbound]

**(3) Reference evidence**
- Resend Inbound parses incoming mail to JSON, stores attachments, POSTs `email.received`; retains mail even with no/failed webhook. [Resend inbound]
- Postmark POSTs full parsed JSON (TextBody, StrippedTextReply, Attachments, Headers, MailboxHash); expects 200, retries 10× with growing intervals, stops on 403. [Postmark inbound]

**(4) Effort: L** · Deps: queue, D (threading), H, blob storage for attachments.

**(5) Tier: Strategic Bet** — high value, newest/most-moving vendor surface; isolate behind the provider port.

---

## F. Bounce / Complaint Handling + Suppression List
**(1) What it enables:** Automatically stop sending to addresses that hard-bounce or mark spam — protects sender reputation/deliverability and prevents legal/abuse issues. Per-tenant suppression so one org's bounce doesn't suppress another's contact.

**(2) Design**
- **Webhook events** drive suppression: `email.bounced` (`type: hard|soft`, with `subtype`), `email.complained`, `email.delivery_delayed` (soft). Handler updates the matching `EmailMessage` status and writes a **Suppression** row.
- **Rules** (per Resend/industry best practice): **hard bounce → suppress immediately**; **complaint → suppress immediately, no exceptions**; **soft bounce → count, suppress after threshold (~3)**. [Resend best-practices]
- **Enforcement:** `Suppression` is `@@unique([orgId, email])` and is consulted by the send service (§A) and bulk enqueue (§C). Optionally mirror to the provider's own suppression for defense-in-depth.
- **Idempotent processing:** dedupe on the webhook event id (store processed ids) — Resend retries ~24h with backoff and events can arrive out of order, so handlers must be replay-safe. [Resend best-practices]

**(3) Reference evidence**
- `email.bounced` = permanent rejection (carries hard/soft `type` + `subtype` e.g. General, NoEmail, MailboxFull, ContentRejected); `email.complained` = marked spam. [Resend webhooks]
- Best practice: hard bounce → immediate suppress; complaint → immediate suppress (no exceptions); soft → suppress after ~3; use event ids for idempotency; ack 2xx within ~5s then process async. [Resend best-practices]

**(4) Effort: M** · Deps: E webhook ingestion infra, H (Suppression model). Tightly coupled to §E-webhooks.

**(5) Tier: Foundation** — non-negotiable for deliverability; ship alongside first real sends.

---

## E2 / G. Open & Click Tracking via Provider Webhooks
**(1) What it enables:** Per-message engagement (delivered/opened/clicked) surfaced on the contact/deal timeline and aggregated for campaign analytics — without building tracking pixels/redirects ourselves.

**(2) Design**
- Enable open/click tracking per sending domain in Resend (provider rewrites links + injects pixel). Subscribe to `email.sent|delivered|opened|clicked|failed`.
- **Single webhook ingest** `src/app/api/email/webhooks/resend/route.ts`: raw body → Svix verify → ack 2xx → enqueue → worker correlates by `providerMessageId` (or `emsg` tag from §A) → appends an `EmailEvent` row and bumps denormalized flags on `EmailMessage` (`firstOpenedAt`, `openCount`, `lastClickedAt`, `clickCount`, clicked-link list).
- **Idempotent + order-tolerant:** dedupe on event id; never let a late `delivered` overwrite a later `opened`. Store all events append-only in `EmailEvent`; treat `EmailMessage` status fields as max/first-wins.
- `email.clicked` carries the clicked **link URL + timestamp** → store per-link for click maps. [Resend webhooks]

**(3) Reference evidence**
- Resend emits `sent, delivered, opened, clicked, bounced, complained, delivery_delayed, failed, received`; envelope `{type, created_at, data{email_id, from, to, subject, …}}`; click events add link URL + timestamp. [Resend webhooks]
- Verify with Svix headers `svix-id`/`svix-timestamp`/`svix-signature` using the signing secret (`whsec_…`) against the **raw** body. [Resend webhooks]

**(4) Effort: M** · Deps: A, H (EmailEvent), webhook infra (shared with §F).

**(5) Tier: Core.**

---

## H. Per-Tenant Sending Domains + DKIM/SPF/DMARC
**(1) What it enables:** Each org sends from its own verified domain (`mail.acme.com`) with proper authentication, so mail lands in inboxes (not spam) and isn't attributed to a shared Smart-CRM reputation. Foundational for deliverability at multi-tenant scale.

**(2) Design**
- Use the **Resend Domains API** to programmatically create a domain per tenant (`resend.domains.create({name, region})`) → returns `id`, `status`, and the **DNS records** (DKIM TXT, SPF/`MX` on the `send.` subdomain for bounce processing, DMARC TXT) to display in a tenant onboarding UI. Poll `domains.get`/verify; Resend rechecks DNS for **72h** before marking `Failure`. [Resend domains], [Resend domain auth]
- Persist a `SendingDomain` row (`orgId`, `provider`, `providerDomainId`, `domain`, `status`, `region`, `dkim/spf/dmarc` record snapshots, `verifiedAt`). `EmailMessage.from`/§A resolve through it.
- **Auth model:** DKIM gives **strict alignment** (DMARC pass via DKIM); SPF is relaxed alignment. Recommend tenants publish DMARC `p=none` → `quarantine` → `reject` as confidence grows. Provide copy-paste records + a "re-check" button. [Resend domain auth]
- **Webhooks per domain:** create webhook endpoints via the Resend API; the create call returns a **signing secret** per endpoint — store it (encrypted) keyed by org/domain for §E/§F/§G verification. [Resend webhooks API]
- Until a tenant verifies, fall back to a shared, well-warmed `smartcrm.app` domain so onboarding isn't blocked.

**(3) Reference evidence**
- Domains API create returns id/status/region + DNS records; supports multiple domains. [Resend domains]
- Resend supports custom DKIM (strict alignment) + SPF (relaxed) + DMARC; requires a TXT + MX on the `send` subdomain (Envelope-From + bounce processing); rechecks DNS for 72h. [Resend domain auth]
- Webhooks are creatable via API and return a per-endpoint signing secret. [Resend webhooks API]

**(4) Effort: L** · Deps: A; onboarding UI (frontend); `SendingDomain` model.

**(5) Tier: Strategic Bet** — big deliverability lever, but adds DNS/onboarding UX + per-tenant secret management.

---

## I. Data Model (Prisma sketches)
*Conventions follow existing schema: `cuid()` ids, `orgId` + `Organization` cascade, `@db.Text` for bodies, composite indexes.*

```prisma
enum EmailDirection { OUTBOUND INBOUND }
enum EmailStatus    { QUEUED SENT DELIVERED BOUNCED COMPLAINED FAILED }
enum EmailProviderKind { RESEND POSTMARK SES SENDGRID }
enum TemplateKind  { CODE USER }
enum SuppressionReason { HARD_BOUNCE COMPLAINT SOFT_BOUNCE_THRESHOLD MANUAL }

model SendingDomain {
  id               String  @id @default(cuid())
  orgId            String
  provider         EmailProviderKind @default(RESEND)
  providerDomainId String?
  domain           String
  region           String?
  status           String  @default("pending") // pending|verified|failure
  dnsRecords       Json?    // DKIM/SPF/DMARC snapshots to render in onboarding
  webhookSecret    String?  // encrypted at rest
  verifiedAt       DateTime?
  createdAt        DateTime @default(now())
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, domain])
  @@index([orgId, status])
}

model Template {
  id        String       @id @default(cuid())
  orgId     String
  kind      TemplateKind @default(USER)
  name      String
  subject   String
  bodyHtml  String?      @db.Text   // USER templates; CODE templates resolved in src/emails
  bodyText  String?      @db.Text
  variables Json?        // allow-listed merge fields
  version   Int          @default(1)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, name])
}

model EmailThread {
  id        String   @id @default(cuid())
  orgId     String
  subject   String?
  contactId String?
  dealId    String?
  token     String   @unique          // plus-address routing token (reply+<token>@)
  createdAt DateTime @default(now())
  org      Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  contact  Contact?     @relation(fields: [contactId], references: [id], onDelete: SetNull)
  deal     Deal?        @relation(fields: [dealId], references: [id], onDelete: SetNull)
  messages EmailMessage[]
  @@index([orgId, contactId])
  @@index([orgId, dealId])
}

model EmailMessage {
  id                String        @id @default(cuid())
  orgId             String
  threadId          String?
  direction         EmailDirection @default(OUTBOUND)
  status            EmailStatus    @default(QUEUED)
  provider          EmailProviderKind @default(RESEND)
  providerMessageId String?       @unique     // join key for webhooks
  messageId         String?       // RFC Message-ID (threading)
  inReplyTo         String?
  references        String?       @db.Text
  fromAddr          String
  toAddr            String        @db.Text    // comma-joined / JSON for multi-recipient
  subject           String?
  bodyHtml          String?       @db.Text
  bodyText          String?       @db.Text
  templateId        String?
  contactId         String?
  dealId            String?
  // denormalized tracking
  sentAt            DateTime?
  deliveredAt       DateTime?
  firstOpenedAt     DateTime?
  openCount         Int           @default(0)
  lastClickedAt     DateTime?
  clickCount        Int           @default(0)
  error             String?       @db.Text
  createdAt         DateTime      @default(now())
  org      Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  thread   EmailThread? @relation(fields: [threadId], references: [id], onDelete: SetNull)
  contact  Contact?     @relation(fields: [contactId], references: [id], onDelete: SetNull)
  deal     Deal?        @relation(fields: [dealId], references: [id], onDelete: SetNull)
  events   EmailEvent[]
  @@index([orgId, status])
  @@index([orgId, contactId])
  @@index([providerMessageId])
}

model EmailEvent {
  id             String   @id @default(cuid())
  orgId          String
  emailMessageId String
  type           String   // delivered|opened|clicked|bounced|complained|delivery_delayed
  providerEventId String? @unique   // idempotency: dedupe webhook replays
  linkUrl        String?  @db.Text  // for clicked
  payload        Json?
  occurredAt     DateTime
  createdAt      DateTime @default(now())
  message EmailMessage @relation(fields: [emailMessageId], references: [id], onDelete: Cascade)
  @@index([emailMessageId, type])
}

model Suppression {
  id        String   @id @default(cuid())
  orgId     String
  email     String
  reason    SuppressionReason
  bounceSubtype String?
  createdAt DateTime @default(now())
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, email])
  @@index([orgId])
}
```
Add back-relations on `Organization`, `Contact`, `Deal` (e.g. `emailMessages EmailMessage[]`). Webhook idempotency hinges on the `@unique` `providerEventId`; tracking correlation on `@unique` `providerMessageId`.

---

## 9. Provider Comparison (assessment)

| Provider | Send DX / React Email | Inbound | Deliverability | Price (≈50K/mo) | Fit for Smart-CRM |
|---|---|---|---|---|---|
| **Resend** (pre-wired) | Best; native React Email; idempotency; webhooks-as-API | **Yes** (GA Nov 2025; JSON + stored attachments; retains on outage) | Strong for <50K/mo on shared IPs | 3K/mo free; usage tiers | **Primary** — one vendor for send+receive |
| **Postmark** | Excellent; strong templating | **Yes, mature** (full parsed JSON inline incl. StrippedTextReply, MailboxHash) | **Best** (transactional-only IP pools, ~99%) | ~$55 (50K) | **Fallback** for critical txn + inbound robustness |
| **Amazon SES** | Bare API; you build templating | DIY (SNS→S3/Lambda, parse MIME yourself) | Your responsibility (warm-up, monitoring) | ~$5 (cheapest) | At scale (500K+/mo) for cost |
| **SendGrid** | Mature; marketing-heavy | Inbound Parse webhook | Mixed (shared pools carry marketing) | ~$20 Essentials | Not recommended unless volume forces it |

[Provider comparison], [Postmark inbound], [Resend inbound]

**Decision:** Resend primary; keep the `EmailProvider` port so a tenant requiring max deliverability can be routed to Postmark, and so SES becomes a cost lever past ~500K/mo. Never couple business logic to a vendor SDK directly.

---

## Top 3 picks

1. **Transactional Sending + Provider Abstraction (§A) + Data Model (§I)** — *Foundation, S/M.* The `EmailProvider` port, `EmailMessage` row, idempotent send, and suppression pre-check. Nothing ships without it, and the abstraction is what keeps Resend/Postmark/SES swappable.
2. **Bounce/Complaint Suppression + Webhook Ingestion (§F, shared infra with §E2/G tracking)** — *Foundation/Core, M.* Signature-verified, idempotent (`providerEventId`), async webhook pipeline that auto-suppresses hard bounces/complaints and records delivered/open/click. Protects deliverability from day one and is the spine for all event-driven email state.
3. **Inbound Parsing + Threading to Contact/Deal (§E + §D)** — *Strategic Bet, L+M.* The defining CRM behavior: replies land on the right contact/deal via plus-address token → References/In-Reply-To → sender match. Highest product value; depends on the queue + webhook infra from picks 1–2, so sequence it third.

---

### Sources
- Resend rate limit (2 req/s, ratelimit headers): https://resend.com/changelog/api-rate-limit
- Resend webhook event types + payloads + Svix verification + bounce subtypes: https://resend.com/docs/dashboard/webhooks/event-types · https://github.com/resend/resend-skills/blob/main/skills/resend/references/webhooks.md
- Resend webhook best practices (suppression rules, idempotency, ack 2xx <5s, ~24h retries): https://github.com/resend/resend-skills/blob/main/skills/email-best-practices/references/webhooks-events.md
- Resend batch (≤100/req) + batch idempotency keys: https://resend.com/docs/api-reference/emails/send-batch-emails · https://resend.com/changelog/batch-idempotency-keys · https://resend.com/changelog/idempotency-keys
- Resend Inbound (receiving, JSON, attachments, retains on outage): https://resend.com/blog/inbound-emails · https://resend.com/docs/dashboard/receiving/introduction
- Resend domains (create API, regions, DNS records) + auth (DKIM strict / SPF relaxed / DMARC, 72h recheck) + webhooks API signing secret: https://resend.com/docs/api-reference/domains/create-domain · https://resend.com/docs/dashboard/domains/introduction · https://resend.com/blog/email-authentication-a-developers-guide · https://resend.com/changelog/managing-webhooks-via-api
- Resend × React Email integration: https://resend.com/blog/introducing-email-skills · https://resend.com/features/email-api
- Postmark inbound webhook (parsed JSON, MailboxHash plus-addressing, StrippedTextReply, Headers In-Reply-To/References, retries/403): https://postmarkapp.com/developer/webhooks/inbound-webhook · https://postmarkapp.com/support/article/understanding-inbound-email-in-postmark · https://postmarkapp.com/developer/user-guide/inbound/parse-an-email
- Serverless queue comparison (QStash vs Inngest vs SQS): https://apiscout.dev/guides/upstash-qstash-vs-inngest-vs-aws-sqs-2026 · https://www.pkgpulse.com/guides/inngest-vs-triggerdev-vs-qstash-serverless-durable-2026
- Provider comparison (SES/Postmark/Resend/SendGrid deliverability + pricing): https://www.buildmvpfast.com/blog/resend-vs-ses-vs-postmark-transactional-email-deliverability-saas-2026 · https://www.suprsend.com/post/selecting-an-email-delivery-platform-key-players-compared-2025
