# Smart-CRM — Background Jobs, Queues & Scheduling (Design Brief)

**Author:** Backend/Platform engineering
**Date:** 2026-06-20
**Scope:** Async execution backbone for Smart-CRM on a serverless stack (Next.js 15 / Vercel, Prisma 5 / Postgres 16, NextAuth v5). RESEARCH/DESIGN ONLY — no repo changes.

---

## TL;DR

Smart-CRM today runs **everything inline** in server actions and request handlers. There is no queue, no scheduler, no cron, no retries (verified: only `src/app/api/auth/[...nextauth]/route.ts` exists under `api/`; no job code anywhere in `src/`). On Vercel's serverless model there is no always-on worker, and even with Fluid Compute a single function invocation caps at **300s default / 800s max (Pro)** — so any unbounded task (bulk email, CSV import, CRM sync) will eventually time out, and any transient failure is lost forever.

**Primary recommendation: Inngest** as the durable jobs/queue/scheduling layer, because it is the only candidate that runs *natively inside Vercel functions over HTTP* (no separate worker host, no Redis) while giving durable step execution, retries/backoff, cron, and per-key concurrency/throttling/idempotency out of the box. **QStash (Upstash)** is the recommended lightweight fallback / second opinion (pure HTTP fan-out + cron, cheapest, fewest moving parts). A **Postgres-backed queue (Graphile Worker / pg-boss)** is explicitly *not* recommended as primary on Vercel because both require a long-running worker process that the serverless platform cannot host.

This is a **Foundation** capability. The features that depend on it: reminders/notifications, email + digests, webhook delivery, third-party sync (Google/email/calendar), bulk operations (import/export/bulk-update), rotting-deal detection, and any future AI enrichment.

---

## Decision context (why the obvious options are constrained)

### The serverless constraint (the whole reason this is hard)
- **No always-on process.** Vercel functions are short-lived and spun up per request; you cannot run a daemon that polls a queue table or holds a Postgres `LISTEN` connection.
- **Hard execution ceiling.** With Fluid Compute (default since Apr 2025) functions default to **300s** and max **800s** on Pro/Enterprise; without Fluid, Hobby is 10s default / 60s max, Pro 15s/300s. Reference: Vercel Functions duration limits. → Even the *best* case still requires chunking long work into many bounded invocations.
- **Vercel Cron limits.** 100 cron jobs/project on all plans; **Hobby can only run a cron once per day**; **Pro supports per-minute**; Vercel auto-provisions `CRON_SECRET` and calls your route with `Authorization: Bearer ${CRON_SECRET}`; schedules run in UTC and are metered as function executions. Reference: Vercel Cron changelog + docs. → Cron is a *trigger*, not an execution engine; it must hand off to a queue.
- **Connection pooling.** `DATABASE_URL` is a **transaction-mode PgBouncer pooler** (`pgbouncer=true&connection_limit=1`), `DIRECT_URL` is only for migrations (confirmed in `.env.example`, `src/env.ts`, `docs/DEPLOY.md`). A Postgres-queue worker wanting `LISTEN/NOTIFY` needs a *session/direct* connection, which the runtime pooler deliberately does not provide.

### Candidate fit summary

| Tool | Execution plane | Runs on Vercel functions? | Needs Redis / long-running worker? | Cron | Verdict |
|------|-----------------|---------------------------|-------------------------------------|------|---------|
| **Inngest** | Inngest cloud invokes *your* HTTP endpoint; code runs in your Vercel function | **Yes** | No | Yes (built-in) | **Primary** |
| **QStash** | Upstash delivers HTTP messages to *your* endpoint | **Yes** | No | Yes (built-in) | **Fallback / simple cases** |
| **Trigger.dev** | Runs your tasks on *its own managed compute* (`npx trigger.dev deploy`), or self-hosted Docker (Webapp+Worker+Redis+Postgres) | No (separate compute plane) | Cloud: no; self-host: yes | Yes | Strategic alt for heavy/long AI work |
| **Graphile Worker** | Long-running Node worker polling Postgres (LISTEN/NOTIFY) | **No** | Yes (worker process) | Yes | Not on pure Vercel |
| **pg-boss** | Long-running Node `boss.work()` polling Postgres | **No** | Yes (worker process) | Yes | Not on pure Vercel |

The two Postgres-native queues are excellent libraries but are documented to require a persistent process: Graphile Worker "requires a long-running process and is not compatible with serverless platforms" (it relies on `LISTEN/NOTIFY` over persistent connections); pg-boss requires a Node process running `boss.work()` to poll. They become viable only if Smart-CRM later adds a dedicated worker host (Render/Railway/Fly/a small VM) — see Capability 8.

---

## Cross-cutting design: the job model

A single shape applies to every capability below, regardless of the chosen engine. The engine handles delivery/retry/state; **Postgres remains the source of truth for business idempotency and audit.**

### Idempotency (three layers)
1. **Deterministic event/job ID** — derive an idempotency key from business identity, e.g. `reminder:{activityId}:{dueAt}` or `webhook:{deliveryId}`. Inngest dedupes identical event IDs and supports a function-level `idempotency` key (one run per key per 24h). QStash supports `deduplicationId` / content-based dedup. This stops the *same* job from being enqueued twice.
2. **At-least-once delivery means handlers must be idempotent.** Both Inngest steps and QStash messages are **at-least-once** — a handler can run twice. Wrap side effects so a replay is a no-op: `INSERT ... ON CONFLICT DO NOTHING` on a unique key, check `sentAt`/`completedAt` before acting, or guard with a Postgres advisory lock.
3. **Outbox table** for events emitted from inside DB transactions (e.g. "deal won → send congrats email"). Write the intent to an outbox row in the *same* transaction as the business write; a tiny relay enqueues it. This avoids the dual-write problem (DB commit succeeds but enqueue fails, or vice-versa).

### Prisma: a generic Job/Outbox + per-feature state
We do **not** need a full queue table when using Inngest/QStash (the engine owns the queue). We *do* want a lightweight **Outbox** (transactional emission) and a **JobRun** audit/observability mirror, plus per-feature dedup columns.

```prisma
// Transactional outbox — written in the same tx as the business mutation.
model OutboxEvent {
  id          String   @id @default(cuid())
  orgId       String
  name        String   // e.g. "deal.won", "contact.imported"
  payload     Json
  status      OutboxStatus @default(PENDING)
  attempts    Int      @default(0)
  enqueuedAt  DateTime?
  createdAt   DateTime @default(now())

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([status, createdAt])
  @@index([orgId])
}
enum OutboxStatus { PENDING ENQUEUED FAILED }

// Lightweight audit mirror of engine runs for in-app observability.
model JobRun {
  id           String   @id @default(cuid())
  orgId        String?
  jobName      String
  externalId   String?  // Inngest run id / QStash message id
  status       JobStatus @default(RUNNING)
  attempt      Int      @default(1)
  error        String?  @db.Text
  startedAt    DateTime @default(now())
  finishedAt   DateTime?
  @@index([orgId, jobName])
  @@index([status, startedAt])
}
enum JobStatus { RUNNING SUCCEEDED FAILED CANCELLED }
```

Per-feature dedup is added to existing models (see capabilities), e.g. `Activity.reminderSentAt`, plus a `WebhookEndpoint`/`WebhookDelivery` pair and an `ImportJob` model. **All job payloads carry `orgId`**, and every handler re-derives tenant scope via the same `requireOrg`-style guard used in `src/lib/tenant.ts` — jobs run *outside* a user session, so they must trust only the signed payload `orgId`, never an ambient session.

### Retries & backoff
- **Inngest:** automatic retries with exponential backoff; default **4 retries (5 total attempts)** per step, each `step.run()` retried independently and memoized so completed steps are not re-run. Configurable per function; non-retriable errors via `NonRetriableError`. Failed runs route to a dead-letter / failure handler (`onFailure`).
- **QStash:** automatic retries on non-2xx with exponential backoff; failed messages land in a **Dead Letter Queue**. Note: **each retry is billed as an additional message**.
- **Postgres queues (if adopted later):** Graphile Worker exponential backoff with configurable `max_attempts`; pg-boss `retryLimit`/`retryDelay`/`retryBackoff`.

### Concurrency & rate control
- **Inngest:** `concurrency` (global + per-function + **per-`key`**, e.g. one run per `orgId` or per external API account), `throttle` (X per period, optionally keyed), `rateLimit` (skip excess), `debounce`. Concurrency limits *step execution*, ideal for protecting downstream APIs (Resend, Google).
- **QStash:** **FlowControl** with a `parallelism` cap and a `rate` (calls/sec) per `flowControlKey`; excess is delayed, not rejected. Queues provide ordered, bounded-parallelism delivery.

### Scheduling/cron
- **Inngest:** functions can be triggered by a cron schedule directly (`{ cron: "0 13 * * *" }`), with `TZ` support — no Vercel Cron needed.
- **QStash:** `schedules.create({ destination, cron })` calls your HTTP endpoint on the cron — replaces Vercel Cron.
- **Vercel Cron (thin glue):** still useful as a free, in-repo trigger (`vercel.json` `crons`) that simply enqueues jobs, e.g. for the **outbox relay** and dev parity. Keep handlers idempotent because Hobby cron fires "sometime in the hour."

### Observability
- **Inngest:** dashboard with per-run timelines, step I/O, replays, metrics; local Dev Server mirrors prod. Mirror key runs into `JobRun` for in-app admin views.
- **QStash:** console shows message logs, retries, DLQ; events API. Thinner than Inngest → lean harder on the `JobRun` table.
- **Common:** structured logs with `orgId` + `jobName` + `externalId`; alert on DLQ depth / `FAILED` `JobRun` rate.

---

## Capabilities

### 1. Jobs/queue foundation (engine + outbox + idempotency)
**(1) What it enables.** A single, reliable way to run *anything* asynchronously off the request path with retries and visibility. Every other capability here is a thin job definition on top of this.

**(2) Design.**
- **Tool:** Inngest. Add `inngest` client + a single serve route `src/app/api/inngest/route.ts` exporting `GET/POST/PUT` via `serve({ client, functions })` (App Router requires all three methods). Set the route's `maxDuration` (e.g. 300) so steps don't get killed.
- **Auth/deploy:** install the **Inngest Vercel integration** → it auto-sets `INNGEST_SIGNING_KEY` and auto-resyncs the app on every Vercel deploy (no manual sync). Add `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` to `src/env.ts`.
- **Emission:** server actions call `inngest.send({ name, data: { orgId, ... } })` instead of doing the work inline. For work emitted *inside* a DB transaction, write an `OutboxEvent` in the same tx, and a Vercel Cron (`*/1` on Pro) or an Inngest cron drains `OutboxEvent` → `inngest.send` → mark `ENQUEUED`.
- **Idempotency:** event IDs derived from business keys; handlers idempotent (see cross-cutting section).

**(3) Reference evidence.**
- Inngest serve handler + App Router GET/POST/PUT, `/api/inngest` endpoint, set `maxDuration`: https://www.inngest.com/docs/learn/serving-inngest-functions and https://www.inngest.com/docs/getting-started/nextjs-quick-start
- Vercel integration auto-sets `INNGEST_SIGNING_KEY` and resyncs on deploy: https://www.inngest.com/docs/deploy/vercel and https://www.inngest.com/docs/apps/cloud
- Durable step memoization + independent retries: https://www.inngest.com/docs/learn/how-functions-are-executed
- Transactional outbox pattern rationale (dual-write): general background-jobs guidance, https://render.com/articles/nextjs-background-jobs-postgresql-production

**(4) Effort:** **M.** Deps: Inngest account + Vercel integration; new env vars; `OutboxEvent`/`JobRun` Prisma models + migration; refactor server actions to emit events.

**(5) Tier:** **Foundation.**

---

### 2. Scheduled reminders & due-activity notifications
**(1) What it enables.** "Activity due in 1 hour / overdue" reminders and task nudges — turning the existing `Activity.dueAt` field into proactive notifications instead of a passive list.

**(2) Design.**
- **Tool:** Inngest **cron function** (`{ cron: "*/15 * * * *", tz: "UTC" }`) that queries `Activity` where `dueAt` is within the next window and `completedAt IS NULL` and `reminderSentAt IS NULL`, then `step.sendEvent` fans out one `reminder.send` event per activity (keeps each delivery independently retriable).
- **Prisma:** add `reminderSentAt DateTime?` to `Activity` (existing index `@@index([orgId, dueAt])` already supports the scan). Set it inside the send handler with a guard (`updateMany where reminderSentAt: null`) so duplicate fan-outs are no-ops.
- **Concurrency:** keyed by `orgId` to spread load; throttle the notification channel.
- **Cron alt:** if staying on Vercel Cron, `vercel.json` `crons: [{ path: "/api/cron/reminders", schedule: "*/15 * * * *" }]` (Pro) guarded by `CRON_SECRET`, which just enqueues.

**(3) Reference evidence.**
- Inngest cron triggers + TZ: https://www.inngest.com/docs/guides/scheduled-functions (cron config) and fan-out via `step.sendEvent`: https://www.inngest.com/docs/guides/fan-out-jobs
- Vercel Cron min frequency by plan + `CRON_SECRET`: https://vercel.com/docs/cron-jobs and https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan

**(4) Effort:** **S–M.** Deps: Capability 1; a notification sink (in-app table now, email via Capability 3 later); `reminderSentAt` migration.

**(5) Tier:** **Core.**

---

### 3. Transactional email delivery (the email backbone)
**(1) What it enables.** Reliable single emails (welcome, password reset, "you were assigned a deal," reminder emails) without blocking the request and with retries — Resend is already anticipated (`RESEND_API_KEY`, `EMAIL_FROM` in `src/env.ts`).

**(2) Design.**
- **Tool:** Inngest function `email.send` wrapping the Resend API call in a `step.run` (so a failed send retries independently and a success is memoized).
- **Idempotency:** event id `email:{purpose}:{entityId}` + pass Resend's idempotency header; record `JobRun` with the Resend message id.
- **Rate control:** `throttle` to stay under Resend's send limits; `concurrency` keyed by `orgId` to prevent one tenant's burst starving others.
- **Emission:** server actions / other jobs call `inngest.send({ name: "email.send", data: { orgId, to, template, vars } })`.

**(3) Reference evidence.**
- Inngest step retries/memoization wrap external API calls safely: https://www.inngest.com/docs/learn/how-functions-are-executed
- Throttling/concurrency keys for protecting downstream providers: https://www.inngest.com/docs/guides/throttling and https://www.inngest.com/docs/functions/concurrency

**(4) Effort:** **S.** Deps: Capability 1; Resend account + verified domain; add `resend` SDK.

**(5) Tier:** **Foundation** (many features emit email; treat as shared backbone).

---

### 4. Scheduled digests (daily/weekly summary emails)
**(1) What it enables.** Per-user or per-org daily/weekly digest: open deals, activities due today, recent wins, rotting deals — recurring engagement driver.

**(2) Design.**
- **Tool:** Inngest cron (`{ cron: "0 13 * * 1-5" }` = 13:00 UTC weekdays) that fans out one `digest.compose` event per active membership (`Membership` table), each composing data and emitting an `email.send` (Capability 3). Per-user fan-out keeps one slow/bad recipient from blocking the batch and makes each retriable.
- **Concurrency:** `concurrency` keyed (global cap) so a 10k-user digest paces itself rather than hammering Postgres/Resend; `throttle` aligned to Resend limits.
- **Idempotency:** event id `digest:{userId}:{yyyy-mm-dd}` so a re-run on the same day won't double-send.
- **Future:** per-user send-time/timezone preference → schedule a delayed event per user (`step.sleepUntil`).

**(3) Reference evidence.**
- Cron + fan-out + per-key concurrency for batch sends: https://www.inngest.com/docs/guides/fan-out-jobs and https://www.inngest.com/docs/functions/concurrency
- Idempotency key (one run per key / 24h): https://www.inngest.com/docs/guides/handling-idempotency

**(4) Effort:** **M.** Deps: Capabilities 1 + 3; digest query/render code.

**(5) Tier:** **Core.**

---

### 5. Rotting-deal & pipeline-hygiene checks
**(1) What it enables.** Detect "stale"/rotting deals (OPEN deals with no `updatedAt`/activity in N days) and stage-time SLA breaches, then notify owners — a differentiating CRM feature that depends entirely on scheduled background scanning.

**(2) Design.**
- **Tool:** Inngest cron (daily, e.g. `0 6 * * *`). Scan `Deal where status = OPEN AND updatedAt < now() - interval`, optionally joining latest `Activity`. Fan out a `deal.rotting` event per deal → emit in-app notification + `email.send` to `ownerId`.
- **Prisma:** reuse existing `@@index([orgId, status])` on `Deal`; add `rotAlertedAt DateTime?` (dedup so we alert once per rot cycle, reset on deal update). Optionally a `DealStageHistory` model later for true stage-duration SLAs.
- **Tenant batching:** keyed concurrency by `orgId`; chunk per org to stay well under function timeout.

**(3) Reference evidence.**
- Scheduled scan-and-fan-out is the canonical Inngest cron pattern: https://www.inngest.com/docs/guides/scheduled-functions
- Why cron must hand to a queue (Vercel cron is metered/short): https://vercel.com/docs/cron-jobs

**(4) Effort:** **M.** Deps: Capabilities 1 (+ 3 for email); `rotAlertedAt` migration; "rotting" definition/config.

**(5) Tier:** **Strategic Bet** (product-differentiating; depends on the foundation but is optional/competitive).

---

### 6. Outbound webhook delivery
**(1) What it enables.** Let customers subscribe to CRM events (deal won, contact created) and receive reliable, retried, signed webhooks — a platform/integration capability that is impossible to do correctly inline.

**(2) Design.**
- **Tool:** **QStash is the natural fit here** (HTTP-out to *arbitrary external URLs* with built-in retry/backoff, DLQ, and signature). For each subscribed endpoint, `qstash.publishJSON({ url: endpoint.url, body, headers: { signature } , retries, deduplicationId })`. Alternatively an Inngest function that loops `step.run` per endpoint — fine if we want all delivery logic in one engine, but QStash is purpose-built for outbound HTTP with per-destination flow control.
- **Prisma:**
  ```prisma
  model WebhookEndpoint {
    id String @id @default(cuid())
    orgId String
    url String
    secret String      // for HMAC signing
    events String[]    // subscribed event names
    active Boolean @default(true)
    org Organization @relation(fields:[orgId], references:[id], onDelete: Cascade)
    @@index([orgId])
  }
  model WebhookDelivery {
    id String @id @default(cuid())
    orgId String
    endpointId String
    eventName String
    payload Json
    status JobStatus @default(RUNNING)
    attempt Int @default(1)
    responseStatus Int?
    externalId String?  // QStash message id
    createdAt DateTime @default(now())
    @@index([orgId, endpointId])
  }
  ```
- **Idempotency/security:** `deduplicationId = deliveryId`; sign body with `endpoint.secret` (HMAC) so receivers can verify; receiver replays are safe because we send a stable delivery id.
- **Flow control:** QStash `FlowControl` keyed per destination host (parallelism + rate) so one slow customer endpoint can't back up everyone.

**(3) Reference evidence.**
- QStash publish to URL + retries + DLQ + `deduplicationId`: https://github.com/upstash/qstash-js (README) and https://upstash.com/docs/qstash/api-reference/messages/publish-a-message
- QStash FlowControl (parallelism + rate per key): https://upstash.com/blog/QStash-rateLimit
- Signature verification via `Receiver.verify`: https://github.com/upstash/qstash-js

**(4) Effort:** **M–L.** Deps: Capability 1 (event emission); QStash account + `QSTASH_TOKEN`/signing keys in env; `WebhookEndpoint`/`WebhookDelivery` models; signing util; management UI.

**(5) Tier:** **Strategic Bet** (platform feature; build when customers ask for integrations).

---

### 7. Bulk operations (CSV import, bulk export, bulk update/delete)
**(1) What it enables.** Import thousands of contacts/companies, export large datasets, and bulk-edit/tag/delete — all of which exceed the inline request budget today (current `contacts/export/route.ts` builds CSV synchronously in-request; current `createContact` is one-at-a-time).

**(2) Design.**
- **Tool:** Inngest **multi-step / batched function**. Trigger `import.contacts` with `{ orgId, fileRef, mapping }`. Use chunking: each `step.run` processes a bounded batch (e.g. 200 rows → `createMany` with `skipDuplicates`), then enqueues the next offset (`step.sendEvent` / a self-continuation) so total work spans many <300s invocations instead of one giant one. This is the serverless-correct alternative to Trigger.dev's "no-timeout" single run.
- **Prisma:**
  ```prisma
  model ImportJob {
    id String @id @default(cuid())
    orgId String
    kind String          // "contacts" | "companies"
    fileRef String       // blob storage key
    total Int @default(0)
    processed Int @default(0)
    failed Int @default(0)
    status JobStatus @default(RUNNING)
    error String? @db.Text
    org Organization @relation(fields:[orgId], references:[id], onDelete: Cascade)
    @@index([orgId, status])
  }
  ```
  Track `processed`/`failed` for a live progress bar (poll `ImportJob`). Use natural unique keys (e.g. `@@unique([orgId, email])`-style) + `createMany skipDuplicates` for idempotent re-runs.
- **Concurrency:** keyed by `orgId` (one import per org at a time) to bound DB load and respect the pooled `connection_limit=1`.
- **Export:** stream to Vercel Blob in chunks, then email/notify a signed download link rather than returning a multi-MB response.

**(3) Reference evidence.**
- Inngest steps run independently/memoized → safe chunked continuation across invocations: https://www.inngest.com/docs/learn/how-functions-are-executed
- Why a single long run won't fit: Vercel function duration caps (300s default / 800s max Pro, Fluid): https://vercel.com/docs/functions/configuring-functions/duration
- Trigger.dev as the "no-timeout single run" alternative if chunking is undesirable: https://trigger.dev/blog/v3-announcement

**(4) Effort:** **L.** Deps: Capability 1; Vercel Blob (or S3) for file staging; `ImportJob` model; refactor import/export paths; progress UI.

**(5) Tier:** **Core** (import/export is table-stakes for a CRM; biggest inline-timeout risk).

---

### 8. Third-party sync (email/calendar/contacts; e.g. Google)
**(1) What it enables.** Two-way sync of contacts/calendar/email with external providers — long-running, rate-limited, paginated, token-refreshing work that is the textbook case for durable jobs.

**(2) Design.**
- **Primary:** Inngest durable function per sync run: `step.run` per API page, `step.sleep`/`step.sleepUntil` to respect provider rate limits and to schedule incremental delta syncs; per-account `concurrency`/`throttle` keyed by the external `accountId` (the `Account` table already stores OAuth tokens) so we never exceed a provider's quota. Token refresh as its own memoized step.
- **Escalation path (Strategic alt):** if a *single* sync legitimately needs to run for many minutes/hours of continuous compute (large mailbox backfill, heavy transformation), **Trigger.dev** is the better engine — it runs tasks on its own managed compute with **no execution-time limit** via checkpoint/resume, decoupled from Vercel's 800s ceiling. Trigger.dev's Vercel integration ties deploys together, so it can coexist with Inngest for these specific heavy tasks.
- **If/when a persistent worker exists:** a Postgres queue (Graphile Worker `runOnce`/scheduled, or pg-boss) becomes viable on a small always-on host (Render/Railway/Fly) sharing the same Postgres — cheapest at high volume, but adds infra to operate.
- **Prisma:** `SyncState` model (`orgId`, `accountId`, `provider`, `cursor`, `lastSyncedAt`, `status`) for incremental cursors + idempotent resume.

**(3) Reference evidence.**
- Inngest durable steps + `sleep`/concurrency for rate-limited multi-step flows: https://www.inngest.com/docs/learn/how-functions-are-executed and https://www.inngest.com/docs/functions/concurrency
- Trigger.dev = managed compute, no timeouts (better for very long single runs): https://trigger.dev/blog/v3-announcement and https://trigger.dev/changelog/vercel-integration
- Graphile Worker / pg-boss need a long-running worker (not serverless): https://github.com/graphile/worker and pg-boss serverless discussion https://github.com/timgit/pg-boss/discussions/403

**(4) Effort:** **L.** Deps: Capabilities 1 (+3 for notifications); OAuth provider integration; `SyncState` model; possibly a second engine (Trigger.dev) or worker host.

**(5) Tier:** **Strategic Bet.**

---

### 9. Dead-letter handling, replays & job observability (operational layer)
**(1) What it enables.** Operators can see what ran, what failed, why, and re-run it — the difference between "we have jobs" and "we can run jobs in production."

**(2) Design.**
- **Tool:** Inngest dashboard (run timelines, step I/O, **replay** of failed runs, metrics) + QStash console/DLQ for webhook deliveries. Mirror into Postgres: every handler writes a `JobRun` (start → success/fail with `error`, `attempt`, `externalId`) and webhook failures persist in `WebhookDelivery`. Add an admin screen listing `FAILED` `JobRun`/DLQ items with a "retry" button (re-emits the original event).
- **Alerting:** scheduled check (cron) over `JobRun status=FAILED` rate and webhook DLQ depth → notify via Capability 3.
- **`onFailure` handlers** for critical jobs to capture terminal failures into `JobRun`/alerts.

**(3) Reference evidence.**
- Inngest observability + replays: https://www.inngest.com/docs/platform/monitor/observability-metrics (dashboard/metrics) and durable-execution failure handling: https://www.inngest.com/docs/learn/how-functions-are-executed
- QStash DLQ + retries billed as messages: https://github.com/upstash/qstash-js and https://upstash.com/pricing/qstash

**(4) Effort:** **S–M.** Deps: Capability 1; `JobRun` model (defined above); small admin UI.

**(5) Tier:** **Foundation** (ship alongside Capability 1; do not defer).

---

## Cost & risk notes
- **Inngest free tier:** 50,000 runs/month — comfortably covers reminders/digests/email/rotting checks for early stage; paid tiers scale per-run. Vendor dependency is the main risk; mitigated because handlers are plain HTTP functions and the *business* idempotency/audit lives in Postgres, so swapping engines is bounded.
- **QStash:** 500 messages/day free (~15k/mo); PAYG **$1 / 100k messages**, Pro $40/mo. **Each retry is billed as a message** — keep retry counts sane for webhooks. Cheapest for pure HTTP fan-out and cron.
- **Vercel Cron:** counts against function-execution quota; keep crons thin (enqueue only). On **Hobby**, per-minute/15-min schedules are impossible (1/day cap) → reminders/digests effectively require **Pro** or moving scheduling into Inngest/QStash (which is the recommendation anyway).
- **Lock-in mitigation:** define jobs behind a tiny internal `enqueue(name, data)` wrapper so Inngest/QStash/(future)Postgres-queue is an implementation detail.

---

## What depends on this foundation (call-out)
This layer is a prerequisite for: **reminders/notifications (Cap 2)**, **all transactional email (Cap 3)**, **digests (Cap 4)**, **rotting-deal detection (Cap 5)**, **outbound webhooks/integrations (Cap 6)**, **CSV import / bulk export / bulk edit (Cap 7)**, **third-party sync (Cap 8)**, and any future **AI enrichment/scoring**. Until Capabilities 1, 3, and 9 exist, every one of these is blocked or forced to run inline (and thus time out / lose data on failure).

---

## Top 3 picks
1. **Jobs/queue foundation on Inngest (Cap 1)** — Foundation, Effort M. The serverless-native engine (runs in Vercel functions over HTTP, no Redis/worker) with durable steps, retries, cron, and per-key concurrency; everything else hangs off it. Ship with the Outbox + idempotency model.
2. **Transactional email backbone (Cap 3)** + **observability/DLQ/replays (Cap 9)** — Foundation, Effort S / S–M. Email is the shared dependency of reminders, digests, rotting alerts, and webhooks; observability makes the whole layer operable in production. Ship together with Cap 1.
3. **Bulk operations via chunked Inngest functions (Cap 7)** — Core, Effort L. Removes the single biggest inline-timeout risk (CSV import/large export) and demonstrates the chunk-across-invocations pattern that the serverless constraint forces. (QStash is the recommended companion specifically for outbound webhook delivery in Cap 6.)
