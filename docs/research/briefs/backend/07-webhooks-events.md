# Smart-CRM — Eventing & Outbound Webhooks: Design Brief

**Domain:** Internal domain-event bus + customer-facing outbound webhooks.
**Author:** Backend/Platform · **Date:** 2026-06-20 · **Status:** Research/design only (no repo changes)

---

## Context & current state (what I found in the repo)

- **Stack:** Next.js 15 (App Router) + Prisma 5.22 + Postgres + NextAuth v5, deployed on **Vercel serverless** (`vercel.json` → `regions: ["iad1"]`, framework `nextjs`). No `crons` configured.
- **All mutations live in server actions** under `src/server/actions/*` and follow one tight, consistent shape — the natural emit points:
  - `contacts.ts`: `createContact`, `updateContact`, `deleteContact`
  - `deals.ts`: `createDeal`, `updateDeal`, **`moveDealToStage`** (the `deal.stage_changed` source of truth), **`setDealStatus`** (won/lost), `deleteDeal`
  - `companies.ts`: `createCompany`, `updateCompany`, `deleteCompany`
  - `activities.ts`: `createActivity`, `toggleActivityComplete`, `deleteActivity`
  - `tags.ts`: `createTag`, `deleteTag`, `setContactTags`
  - `org.ts`: `updateOrgName`, `inviteMember`, `changeMemberRole`, `removeMember`
  - `auth.ts`: `signUpAction` (org bootstrap)
- **Tenancy:** every action calls `requireOrg()` (`src/lib/tenant.ts`) → `{ userId, orgId, role }`. Every domain row is `orgId`-scoped. Events and webhooks **must** carry `orgId` and be tenant-isolated.
- **DB client:** `src/lib/db.ts` is a singleton `PrismaClient` (`db`). Transactions use `db.$transaction(...)` — already used in `org.ts`/`auth.ts`, so the outbox-in-same-tx pattern fits cleanly.
- **Result convention:** `ActionResult<T>` (`src/lib/action-result.ts`) with `ok()`/`fail()`. Emitting must never change these return types or throw on the hot path.
- **No API routes** except `src/app/api/auth/[...nextauth]/route.ts`. There is **no job runner, no queue, no event bus** today (confirmed gap).

**The serverless constraint that shapes everything:** Vercel functions are ephemeral and time-bounded — you cannot run a long-lived worker that holds a queue connection. Background/retried delivery must be driven by **HTTP-invoked** workers (Vercel Cron polling, or a push queue like Upstash QStash that POSTs back to a route). This is the single biggest design driver and is called out per-capability below. ([Upstash QStash — serverless background jobs, no long-running consumers](https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8))

---

## Architecture at a glance

```
server action (createDeal, moveDealToStage, …)
   │  (same Postgres tx as the domain write)
   ├─► domain row INSERT/UPDATE
   └─► EventOutbox INSERT  ◄── transactional outbox (atomic with the mutation)
                │
   [dispatcher]  Vercel Cron (poll)  OR  QStash (push)   ── claims unprocessed rows (SKIP LOCKED)
                │
                ├─► internal subscribers (automations / notifications — other teams) via Event log
                └─► webhook fan-out: for each matching WebhookEndpoint → enqueue WebhookDelivery
                                                │
                              [delivery worker] HTTP POST signed payload (HMAC), record attempt
                                                ├─ 2xx → succeeded
                                                └─ non-2xx/timeout → schedule retry (exp backoff) → dead-letter → replayable
```

Two reliability boundaries, both at-least-once:
1. **Mutation → event** (outbox guarantees the event is never lost if the tx commits).
2. **Event → endpoint** (delivery queue guarantees retry until success/exhaustion).
Consumers must therefore be idempotent; we ship a stable event `id` for dedup. ([At-least-once, never exactly-once — idempotency is the consumer's job](https://codelit.io/blog/api-webhooks-delivery-guarantee))

---

## Capabilities

### 1. Internal domain-event model + typed catalog
**What it enables:** A single, versioned vocabulary (`contact.created`, `contact.updated`, `contact.deleted`, `company.*`, `deal.created`, `deal.updated`, `deal.stage_changed`, `deal.status_changed`, `deal.deleted`, `activity.created`, `activity.completed`, `member.invited`, …). Every other team (automations, integrations, notifications) builds against this one contract instead of each team re-deriving "what changed."

**Design.** A discriminated-union TS type plus a runtime registry. Each event = stable `type`, a `schemaVersion`, and a typed `data` payload (a thin, public-safe projection of the entity — never raw Prisma rows, so we control PII and don't leak internal columns). Envelope is **Standard Webhooks**-shaped so internal and external consumers share one format. ([Standard Webhooks / Svix envelope](https://www.standardwebhooks.com/verify/svix))

```ts
// src/lib/events/catalog.ts (sketch)
export type DomainEvent =
  | { type: "deal.stage_changed"; v: 1; data: { id: string; fromStageId: string|null; toStageId: string; title: string } }
  | { type: "deal.status_changed"; v: 1; data: { id: string; status: "OPEN"|"WON"|"LOST" } }
  | { type: "contact.created"; v: 1; data: { id: string; firstName: string; lastName: string; email: string|null } }
  // …one variant per event
export interface EventEnvelope<T extends DomainEvent = DomainEvent> {
  id: string;            // ULID — also the consumer idempotency key
  type: T["type"];
  orgId: string;         // tenant scope (from requireOrg())
  actorUserId: string|null;
  occurredAt: string;    // ISO8601
  data: T["data"];
}
```

**Reference evidence.** Stripe models everything as a typed `Event` object with a string `type` and a versioned API; subscribers filter on `type`. Svix recommends documenting each event type and versioning payloads explicitly. ([Stripe webhooks — event object & types](https://docs.stripe.com/webhooks)) · ([Svix — documenting & versioning webhooks](https://docs.svix.com/documenting-webhooks))

**Effort:** **S** (types + a tiny registry; no infra). **Deps:** none — pure foundation.
**Tier:** **Foundation.**

---

### 2. Transactional outbox table (`EventOutbox`) + emit helper
**What it enables:** Reliable, exactly-once-*capture* of events: if the domain mutation commits, the event is guaranteed recorded; if the tx rolls back, no phantom event. Decouples "something happened" from "deliver it," so the hot path stays fast and never depends on an external system being up.

**Design.** Add an outbox row **inside the same `db.$transaction` as the mutation**. A dispatcher (Cap. 6) drains it. This is the classic outbox/relay: write side-effect intent in-tx, a separate poller relays it. ([Outbox pattern — write to outbox in-tx, separate worker relays](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/))

```prisma
model EventOutbox {
  id           String   @id @default(cuid())   // == envelope.id
  orgId        String
  type         String                          // "deal.stage_changed"
  schemaVer    Int      @default(1)
  actorUserId  String?
  payload      Json                             // the EventEnvelope.data projection
  occurredAt   DateTime @default(now())
  // dispatch bookkeeping
  status       OutboxStatus @default(PENDING)   // PENDING | DISPATCHED | FAILED
  lockedAt     DateTime?
  dispatchedAt DateTime?
  attempts     Int      @default(0)
  @@index([status, occurredAt])                 // poller scan
  @@index([orgId, type, occurredAt])            // audit/replay
}
enum OutboxStatus { PENDING DISPATCHED FAILED }
```

Emit helper keeps server actions one line heavier and never throws on the hot path:
```ts
// inside createDeal, after building `data`:
const created = await db.$transaction(async (tx) => {
  const deal = await tx.deal.create({ data });
  await emit(tx, { type: "deal.created", orgId, actorUserId: userId, data: project(deal) });
  return deal;
});
```
Convert the few actions that currently do a bare `db.x.create` (e.g. `createContact`, `createDeal`, `moveDealToStage`, `setDealStatus`) to wrap the write + `emit` in `$transaction`. `moveDealToStage`/`setDealStatus` need the **prior** value read in-tx to populate `fromStageId`/old status.

**Reference evidence.** Outbox is the canonical way to get atomic "state change + event" on a single relational DB without distributed transactions; a relay/poller then publishes. ([The Outbox Pattern](https://dev.to/igornosatov_15/the-outbox-pattern-a-love-letter-to-eventual-consistency-3ch3)) · ([Outbox/inbox & delivery guarantees](https://event-driven.io/en/outbox_inbox_patterns_and_delivery_guarantees_explained/))

**Effort:** **M** (migration + `emit()` + touch ~12 actions to wrap in tx). **Deps:** Cap. 1.
**Tier:** **Foundation.**

---

### 3. In-Postgres queue with `FOR UPDATE SKIP LOCKED` (vs external bus)
**What it enables:** A durable work queue for both outbox dispatch and webhook deliveries **without adding Kafka/SQS/RabbitMQ**. Keeps the stack to "just Postgres," which matches the team's current footprint and avoids new ops burden — the right default until volume forces a change.

**Design.** Both `EventOutbox` and `WebhookDelivery` (Cap. 4) double as queues. A worker claims a batch atomically:
```sql
UPDATE "WebhookDelivery"
SET status='DELIVERING', "lockedAt"=now()
WHERE id IN (
  SELECT id FROM "WebhookDelivery"
  WHERE status='PENDING' AND "nextAttemptAt" <= now()
  ORDER BY "nextAttemptAt"
  FOR UPDATE SKIP LOCKED
  LIMIT 50
) RETURNING *;
```
`SKIP LOCKED` lets concurrent worker invocations grab disjoint rows with no double-processing — exactly what you want when Vercel may run several function instances. **Decision: start in-Postgres; defer an external bus.** Revisit if sustained throughput exceeds a few hundred events/sec or you need multi-region fan-out — Svix itself runs a real broker at scale, but that's a Strategic Bet, not a starting point. ([Svix webhook architecture — dispatcher persists attempt status back to storage](https://www.svix.com/blog/webhook-architecture-design/))

**Trade-off table (record in ADR):**
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Postgres + SKIP LOCKED | no new infra, transactional with mutations, easy replay/audit | polling latency, DB load at high volume | **Start here** |
| Upstash QStash (push) | serverless-native, built-in retries+DLQ, survives deploys | external dep, 60s endpoint timeout, $/msg | Adopt for delivery driver (Cap. 6) |
| Kafka/SQS broker | high throughput, true streaming | heavy ops, overkill now | Strategic Bet later |

**Reference evidence.** `SELECT … FOR UPDATE SKIP LOCKED` is the standard Postgres-as-queue concurrency primitive; dispatchers persist per-attempt status back to storage. ([Svix — dispatcher writes status/response back to storage](https://www.svix.com/blog/webhook-architecture-design/))

**Effort:** **S–M** (raw SQL claim query + a couple of indexes; reuses tables from Cap. 2/4). **Deps:** Cap. 2, 4.
**Tier:** **Foundation.**

---

### 4. Webhook subscriptions: `WebhookEndpoint` (registration + event filtering)
**What it enables:** Customers self-register HTTPS endpoints, choose which event types they want, and get a per-endpoint signing secret. This is the public product surface that makes integrations/automations possible for end users.

**Design.**
```prisma
model WebhookEndpoint {
  id            String   @id @default(cuid())
  orgId         String                          // tenant-scoped (requireOrg)
  url           String                          // https only, validated, SSRF-guarded
  description   String?
  enabledEvents String[]                        // ["deal.*","contact.created"] ; "*" = all
  secret        String                          // "whsec_<base64>" — for HMAC (Cap. 5)
  status        EndpointStatus @default(ENABLED)// ENABLED | DISABLED (auto-disabled after sustained failure)
  disabledAt    DateTime?
  createdAt     DateTime @default(now())
  org           Organization @relation(fields:[orgId], references:[id], onDelete: Cascade)
  deliveries    WebhookDelivery[]
  @@index([orgId])
}
enum EndpointStatus { ENABLED DISABLED }
```
- **Registration**: new server actions in `src/server/actions/webhooks.ts` (`createEndpoint`, `updateEndpoint`, `rotateSecret`, `deleteEndpoint`), gated by `requireRole(role,"ADMIN")` like `org.ts` already does. Validate `url` is `https`, reject private/loopback/link-local ranges (**SSRF guard**) and resolve+pin at send time.
- **Filtering**: glob match `enabledEvents` against `event.type` at fan-out; `"*"` and `"resource.*"` wildcards mirror Stripe's `enabled_events`.
- **Secret**: generated `whsec_` + 24+ random bytes base64; show full value once on create, store as-is (or encrypted at rest), expose only last 4 thereafter; `rotateSecret` supports overlap window.

**Reference evidence.** Stripe endpoints carry `enabled_events` (filter), a per-endpoint `secret` (`whsec_…`), `api_version`, and a `status`; test/live each have distinct secrets. Svix uses a unique signing key per endpoint. ([Stripe — endpoint, enabled_events, signing secret](https://docs.stripe.com/webhooks)) · ([Svix — unique key per endpoint](https://www.svix.com/blog/webhook-architecture-design/))

**Effort:** **M** (model + CRUD actions + admin UI hook + SSRF validation). **Deps:** Cap. 1.
**Tier:** **Core.**

---

### 5. HMAC signing (Standard Webhooks / Stripe-compatible) + replay protection
**What it enables:** Receivers can cryptographically verify a payload came from Smart-CRM and wasn't tampered with or replayed — table stakes for any webhook product and a security requirement.

**Design.** Adopt the **Standard Webhooks** scheme (what Svix emits), which is also conceptually identical to Stripe's:
- Headers per delivery: `webhook-id` (the delivery/event id, stable across retries → consumer dedup key), `webhook-timestamp` (epoch seconds), `webhook-signature`.
- **Signed content** = `${id}.${timestamp}.${rawBody}`.
- **Signature** = `v1,<base64(HMAC_SHA256(key = secret_after_whsec_prefix, signed_content))>`. Space-delimited list lets us emit multiple versions during secret rotation.
- **Replay protection**: receivers reject if `|now - webhook-timestamp|` exceeds tolerance (Stripe default **5 minutes**); timestamp is inside the signed content so it can't be forged.
- We document a verify snippet and recommend customers use the Svix/Standard-Webhooks libs.

```ts
function sign(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}
```
Compare with constant-time equality on the receiver side (we note this in docs).

**Reference evidence.** Svix: HMAC-SHA256, headers `webhook-id`/`webhook-timestamp`/`webhook-signature`, signed content = `id.timestamp.payload`, signature `v1,<base64>`, key = part after `whsec_`. Stripe: `Stripe-Signature` with `t=` + `v1=`, signed payload `${t}.${body}`, 5-min default tolerance, HMAC-SHA256, raw body required. ([Svix — signing & verification](https://www.standardwebhooks.com/verify/svix)) · ([Stripe — Stripe-Signature, t=/v1=, replay tolerance](https://docs.stripe.com/webhooks)) · ([Stripe webhooks review — whsec_, HMAC-SHA256](https://www.svix.com/resources/webhook-reviews/stripe-webhooks-review/))

**Effort:** **S** (pure crypto helper + header assembly; ~30 lines). **Deps:** Cap. 4 (needs `secret`).
**Tier:** **Core.**

---

### 6. Delivery engine: retries w/ exponential backoff + serverless driver
**What it enables:** "Set it and forget it" reliability — transient receiver outages don't lose events; deliveries are retried on a backoff curve until success or exhaustion. This is what makes the product trustworthy.

**Design.**
```prisma
model WebhookDelivery {
  id            String   @id @default(cuid())
  endpointId    String
  orgId         String
  eventId       String                          // links to EventOutbox/Event (idempotency)
  eventType     String
  payload       Json                             // frozen envelope sent (for replay)
  status        DeliveryStatus @default(PENDING) // PENDING|DELIVERING|SUCCEEDED|FAILED|DEAD
  attempts      Int      @default(0)
  nextAttemptAt DateTime @default(now())         // backoff target (queue key, Cap. 3)
  lockedAt      DateTime?
  endpoint      WebhookEndpoint @relation(fields:[endpointId], references:[id], onDelete: Cascade)
  attemptLogs   WebhookDeliveryAttempt[]
  @@index([status, nextAttemptAt])               // claim query
  @@index([orgId, eventType])
}
enum DeliveryStatus { PENDING DELIVERING SUCCEEDED FAILED DEAD }
```
- **Backoff schedule** (adopt Svix's curve): attempt immediately, then **+5s, +5m, +30m, +2h, +5h, +10h, +10h**. On each non-2xx/timeout, `attempts++` and set `nextAttemptAt = now + delay[attempts]`. After the curve is exhausted (≈ sustained failure window), mark `DEAD` (Cap. 7). Stripe's analogous curve runs ~16 tries over ~3 days. We keep a tight per-attempt HTTP timeout (e.g. 10–15s) since the receiver should 2xx fast and process async.
- **Serverless driver — two-stage, HTTP-invoked (the key serverless decision):**
  1. **Dispatcher** drains `EventOutbox` → fan-out to matching enabled endpoints → insert `WebhookDelivery` rows (`nextAttemptAt = now`).
  2. **Delivery worker** claims due `WebhookDelivery` (Cap. 3 SKIP LOCKED), POSTs signed payload, records attempt, reschedules or completes.
  - **Driver options:** (a) **Vercel Cron** hitting `/api/jobs/dispatch` + `/api/jobs/deliver` every minute (simplest, all-Postgres, ~minute latency); (b) **Upstash QStash** push — enqueue one QStash message per delivery with a callback URL; QStash handles retry + DLQ and POSTs our function, eliminating polling and surviving deploys (better latency, native serverless). **Recommended: Cron for v1, QStash when latency/scale matters.** Protect job routes with a shared secret / Vercel cron header.

**Reference evidence.** Svix exponential schedule: immediate, 5s, 5m, 30m, 2h, 5h, 10h, 10h; endpoint disabled after 5 days of failure. Stripe: exponential backoff, ~16 attempts over ~3 days, then disables endpoint + notifies. QStash: HTTP delivery to endpoints, automatic retries, DLQ, no long-running consumer, 60s timeout — purpose-built for serverless. ([Svix retry schedule](https://docs.svix.com/retries)) · ([Stripe retry/backoff & auto-disable](https://www.svix.com/resources/webhook-reviews/stripe-webhooks-review/)) · ([QStash retries + DLQ, serverless](https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8))

**Effort:** **L** (delivery state machine, backoff scheduler, two job routes, cron/QStash wiring, SSRF-safe fetch). **Deps:** Cap. 2, 3, 4, 5.
**Tier:** **Core.**

---

### 7. Dead-letter + auto-disable + operational events
**What it enables:** Failures become visible and bounded instead of silently looping forever. Persistently broken endpoints get auto-disabled (protecting our infra and the customer's), and the customer is notified so they can fix and replay.

**Design.**
- When a `WebhookDelivery` exhausts the backoff curve → `status = DEAD` (the dead-letter state; rows are retained, not deleted, for inspection/replay).
- **Auto-disable**: if an endpoint has only failures over a rolling window (mirror Svix's **5 days** / Stripe's ~3 days), set `WebhookEndpoint.status = DISABLED`, stamp `disabledAt`, stop scheduling new deliveries to it.
- **Operational events**: emit internal events `webhook.endpoint.disabled` and `webhook.delivery.exhausted` (Svix sends `EndpointDisabledEvent` / `message.attempt.exhausted`) — surfaced in-app and optionally to a meta-endpoint, so notifications team can alert the customer.

**Reference evidence.** Svix moves exhausted messages to a dead-letter concept, marks them `Failed`, disables the endpoint after 5 days, and emits `message.attempt.exhausted` + `EndpointDisabledEvent`. Stripe auto-disables after ~3 days of continuous failure and notifies. ([Svix — dead letter, disable, operational webhooks](https://docs.svix.com/retries)) · ([DLQ after N retries for later inspection](https://codelit.io/blog/api-webhooks-delivery-guarantee))

**Effort:** **M** (state transitions + rolling-failure check + 2 operational event types). **Deps:** Cap. 6.
**Tier:** **Core.**

---

### 8. Delivery logs + manual replay (customer-facing)
**What it enables:** Customers can audit every attempt (status code, response snippet, timing), debug their integration, and **re-send** a past event after fixing their endpoint — the #1 support-deflecting feature for any webhook product.

**Design.**
```prisma
model WebhookDeliveryAttempt {
  id           String   @id @default(cuid())
  deliveryId   String
  attemptNo    Int
  requestAt    DateTime @default(now())
  responseCode Int?                              // null = network error/timeout
  responseMs   Int?
  responseBody String?  @db.Text                 // truncated (e.g. first 2KB)
  error        String?
  delivery     WebhookDelivery @relation(fields:[deliveryId], references:[id], onDelete: Cascade)
  @@index([deliveryId, attemptNo])
}
```
- **Logs UI**: list deliveries per endpoint with status, event type, attempt count, last response; drill into per-attempt rows. Retention policy (e.g. 30–90 days) trimmed by the same cron.
- **Replay**: `replayDelivery(id)` action (ADMIN-gated) clones the frozen `payload` into a **new** `WebhookDelivery` with a fresh delivery id but the **same `eventId`** — so a well-behaved (idempotent) receiver dedupes. Also support "replay all failed since <date>" and "send a test event," matching Svix's app-portal replay/retry.
- Because we persist the exact `payload` sent, replays are byte-faithful and re-signed with the current secret.

**Reference evidence.** Svix portal lets customers manually retry a message, auto-retry all failures from a date, replay never-attempted messages, and inspect status/response — backed by the dispatcher writing status+response code to storage. ([Svix — manual retry / replay from date / inspect](https://docs.svix.com/retries)) · ([Svix architecture — persist status & response](https://www.svix.com/blog/webhook-architecture-design/))

**Effort:** **M** (attempt table + logs UI + replay actions). **Deps:** Cap. 6 (and 4 for UI).
**Tier:** **Core.**

---

### 9. Persisted `Event` log (queryable history & internal subscribers) — *optional/strategic*
**What it enables:** A durable, queryable record of every event independent of outbox bookkeeping — powers an internal event-subscriber API for the automations/notifications teams, future event-sourced features, analytics/audit, and "events" tab in the product.

**Design.** Promote dispatched outbox rows into a long-lived `Event` table (or just retain `EventOutbox` long-term and treat `DISPATCHED` rows as the log). Internal consumers register handlers keyed by `type` and are invoked by the dispatcher in the same drain loop (in-process fan-out), each tracking its own cursor/idempotency. This is the seam where automations and notifications plug in without touching server actions.

```prisma
model Event {
  id          String   @id            // == envelope.id (ULID), idempotency key
  orgId       String
  type        String
  schemaVer   Int
  actorUserId String?
  payload     Json
  occurredAt  DateTime
  @@index([orgId, type, occurredAt])
}
```

**Reference evidence.** Stripe exposes a queryable Events API as the system of record for what happened; treating events as a first-class, retained log is standard for an event backbone. ([Stripe — Events as system of record](https://docs.stripe.com/webhooks)) · ([Designing observable, replay-safe webhook/event systems](https://dev.to/art_light/webhooks-at-scale-designing-an-idempotent-replay-safe-and-observable-webhook-system-7lk))

**Effort:** **M** (table + internal subscriber registry + fan-out hook). **Deps:** Cap. 2.
**Tier:** **Strategic Bet** (do once 2+ internal consumers actually need it; otherwise `EventOutbox` retention covers v1).

---

## Cross-cutting notes

- **Idempotency everywhere:** envelope `id` (ULID) is the dedup key on both sides; we advertise `webhook-id` so receivers dedup. Internal subscribers must be idempotent too (at-least-once). ([idempotency is the consumer's job](https://codelit.io/blog/api-webhooks-delivery-guarantee))
- **Tenant isolation:** `orgId` on every event/endpoint/delivery row; all queries scoped via `requireOrg()`; webhook CRUD ADMIN-gated via existing `requireRole`.
- **Security:** HTTPS-only endpoints, SSRF guard (block private/loopback/metadata IPs, resolve+pin at send), secrets stored encrypted / shown once, signed payloads, replay tolerance.
- **Serverless reality check:** no daemon workers — everything is HTTP-invoked (Vercel Cron or QStash). Keep per-attempt timeouts short; do fan-out and delivery in small batched function runs to stay under limits. ([QStash 60s timeout, no long-running workers](https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8))
- **Migration path off Postgres queue:** if volume outgrows SKIP LOCKED polling, swap the *driver* (Cap. 6) to QStash/Kafka without changing the event model or schemas.

---

## Top 3 picks

1. **Transactional outbox (`EventOutbox`) + `emit()` helper (Cap. 2)** — the keystone. Atomic "mutation + event" on the existing Postgres/`$transaction` setup; every other capability and every other team depends on it. Foundation, effort M.
2. **In-Postgres queue with `FOR UPDATE SKIP LOCKED` + HTTP-invoked delivery driver (Cap. 3 + 6)** — durable retries/backoff with zero new infra, serverless-correct via Vercel Cron now / QStash later. Turns "events exist" into "events get delivered reliably." Foundation+Core.
3. **Webhook subscriptions + HMAC signing + delivery logs/replay (Cap. 4 + 5 + 8)** — the customer-facing product: register endpoints, verify signatures (Standard Webhooks/Stripe-compatible), inspect attempts, and replay. This is what ships externally and deflects support. Core.
