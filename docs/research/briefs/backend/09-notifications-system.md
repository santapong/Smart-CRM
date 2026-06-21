# Smart-CRM — Notifications System (Backend Design Brief)

**Author:** Backend/platform engineering
**Date:** 2026-06-20
**Scope:** Channel-agnostic notifications backend powering @mentions, assignment alerts, due-task reminders, and a notification center across **in-app, email, and web push**, with preferences, digests, fan-out, dedup/rate-limiting, and real-time delivery.

---

## Context & current state (what exists today)

Read of the repo (`prisma/schema.prisma`, `src/lib/*`, `src/server/actions/*`):

- **Stack:** Next.js 15 (App Router) + Prisma 5 + Postgres + NextAuth v5, deployed on Vercel (serverless). pnpm. Vitest/Playwright.
- **Tenancy:** `Organization` → `Membership` (`Role` = OWNER/ADMIN/MEMBER) → `User`. Every domain row is org-scoped via `orgId`. Tenant guard is `requireOrg()` in `src/lib/tenant.ts`, returning `{ userId, orgId, role }`.
- **Domain models:** `Company`, `Contact`, `Deal` (has `ownerId`, `stageId`, `status`), `Activity` (`type` TASK/CALL/MEETING/NOTE, `dueAt`, `completedAt`, `ownerId`). See `prisma/schema.prisma` lines 100-240.
- **Mutation surface:** server actions in `src/server/actions/*.ts` (e.g. `deals.ts`, `activities.ts`). These are the natural place to emit domain events.
- **Email:** `RESEND_API_KEY` and `EMAIL_FROM` are already declared in `src/env.ts` (lines 11-12) but **unused** — no `resend` package, no mailer.
- **Gaps confirmed (no matches in repo):** no notification model, no events/outbox, no queue, no cron, no `resend`/`pusher`/`web-push`/`qstash`/`inngest` deps, **no comment/@mention model**, **no `assignedToId`** (only `ownerId` on Deal/Activity).

**Serverless constraints (load-bearing for every decision):** Vercel Functions are short-lived, cannot run background processes or hold connections open after the response returns, and **do not support WebSockets**; persistent push requires a third-party pub/sub. Scheduled work needs Vercel Cron (route invocation on a schedule) and/or an HTTP queue (QStash/Inngest) — there is no always-on worker. ([Vercel community / docs via search](https://github.com/vercel/community/discussions/422), [Upstash QStash](https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8))

**Prerequisite note:** @mentions and assignment alerts require source data that does not exist yet. This brief assumes (and flags as deps) a lightweight `Comment` model and an `assignedToId` field on `Deal`/`Activity`. Those belong to collaboration/CRM workstreams; here they are upstream event sources.

---

## Architecture at a glance

```
domain mutation (server action)
   │  (same DB tx)
   ▼
NotificationEvent  ─── outbox row, status=PENDING        [transactional outbox]
   │
   ▼  drained by Vercel Cron (~1/min) → POST to QStash/internal route
generation pipeline (per event type → recipient resolver → fan-out)
   │
   ├─ preference check (per user × type × channel) + quiet hours
   ├─ dedup key + rate-limit gate
   ▼
Notification (1 row per recipient, channel-agnostic)  ──► in-app feed (read/seen state)
   │
   ├─ NotificationDelivery(IN_APP)   → real-time fan-out (SSE or Pusher)
   ├─ NotificationDelivery(EMAIL)    → Resend (immediate) OR digest queue
   └─ NotificationDelivery(PUSH)     → web-push to PushSubscription rows
                                          │
digest cron (daily/weekly per user tz) ───┘ aggregates batched items → 1 email
```

Core idea borrowed from notification-infra vendors: **decouple the notification (what happened, to whom) from the delivery (per-channel attempt)**, and run **per-recipient preference + dedup evaluation** before any channel fires. ([MagicBell — Notification System Design](https://www.magicbell.com/blog/notification-system-design), [Knock — how it works](https://docs.knock.app/getting-started/how-knock-works))

---

## Capabilities

### 1. Channel-agnostic Notification model + in-app feed (read/seen state)
**What it enables:** A single source of truth for "something happened that a user should know about," rendered in a notification center with unread badges and seen/read tracking — independent of which channels deliver it.

**Design.** One `Notification` per recipient (post-fan-out), plus a `NotificationDelivery` child per channel attempt so delivery status never pollutes feed state. Separate `seenAt` (entered viewport / badge cleared) from `readAt` (opened) — this is the standard feed status model. ([Knock — feeds](https://docs.knock.app/in-app-ui/feeds/overview))

```prisma
enum NotificationType {
  MENTION
  ASSIGNMENT          // deal/activity assigned to you
  TASK_DUE            // activity dueAt approaching/overdue
  DEAL_STAGE_CHANGED
  DEAL_WON
  DEAL_LOST
  DIGEST              // synthetic, holds a rolled-up batch
}

enum NotificationChannel { IN_APP EMAIL PUSH }

model Notification {
  id          String           @id @default(cuid())
  orgId       String                                   // tenant scope (mirrors all domain rows)
  recipientId String                                   // User.id
  actorId     String?                                  // who caused it (User.id), nullable for system
  type        NotificationType
  // Stable reference to the subject, no FK so source rows can be deleted:
  entityType  String?                                  // "Deal" | "Activity" | "Contact" | ...
  entityId    String?
  title       String                                   // pre-rendered, channel-neutral summary
  body        String?          @db.Text
  data        Json?                                    // structured payload for deep-link + email/push render
  groupKey    String?                                  // for collapsing ("3 new comments on Deal X")
  seenAt      DateTime?
  readAt      DateTime?
  archivedAt  DateTime?
  createdAt   DateTime         @default(now())

  recipient   User             @relation("NotifRecipient", fields: [recipientId], references: [id], onDelete: Cascade)
  deliveries  NotificationDelivery[]

  @@index([orgId, recipientId, createdAt])             // feed query: my notifs newest-first
  @@index([recipientId, readAt])                        // unread count
}

model NotificationDelivery {
  id             String              @id @default(cuid())
  notificationId String
  channel        NotificationChannel
  status         String              // QUEUED | SENT | DELIVERED | FAILED | SKIPPED_PREF | SKIPPED_QUIET | DIGESTED
  providerId     String?             // Resend message id / push receipt
  error          String?
  attempts       Int                 @default(0)
  scheduledFor   DateTime?           // for digest/quiet-hours deferral
  sentAt         DateTime?
  notification   Notification        @relation(fields: [notificationId], references: [id], onDelete: Cascade)

  @@unique([notificationId, channel])
  @@index([channel, status, scheduledFor])              // worker pickup
}
```

Feed reads: `where: { orgId, recipientId, archivedAt: null }` ordered by `createdAt desc`; unread badge = `count(readAt: null)`. Mark-seen/read are tiny server actions reusing `requireOrg()`. **Tenant rule:** filter on `orgId` AND `recipientId` everywhere (a user in two orgs sees only the active org's feed), matching the existing `requireOrg()` pattern in `src/lib/tenant.ts`.

**Reference evidence.** Knock separates feed message *status* (`seen`/`read`/`unread`/`archived`) from delivery and lets the feed filter by status — directly informs the seen/read split and `archivedAt`. ([Knock feeds](https://docs.knock.app/in-app-ui/feeds/overview)) Decoupling notification from per-channel delivery is the canonical notification-system pattern. ([MagicBell](https://www.magicbell.com/blog/notification-system-design))

**Effort:** **S** (two models + 4 thin server actions + feed query). **Deps:** none — pure foundation.
**Tier:** **Foundation.**

---

### 2. Per-user / per-type / per-channel preferences + quiet hours
**What it enables:** Users control which event types reach them on which channels ("email me on assignment, in-app only for stage changes, never push @mentions"), plus an org/user quiet-hours window so off-hours noise defers instead of pinging.

**Design.** A row per (`user` × `type`), each holding per-channel booleans. Absent row = sensible defaults from a static `DEFAULT_PREFS` map (so we don't backfill). Evaluation order mirrors Knock's "most specific wins, opt-out is sticky": explicit row > category/type default > channel-type default. ([Knock — preferences overview](https://docs.knock.app/preferences/overview))

```prisma
model NotificationPreference {
  id        String           @id @default(cuid())
  userId    String
  orgId     String                                   // prefs are per-membership (org-scoped)
  type      NotificationType
  inApp     Boolean          @default(true)
  email     Boolean          @default(true)
  push      Boolean          @default(false)
  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, orgId, type])
}

model NotificationSettings {                          // one per user×org: cross-cutting controls
  userId        String
  orgId         String
  timezone      String   @default("UTC")              // for quiet hours + digest scheduling
  quietStart    Int?                                  // minutes-from-midnight, e.g. 22:00 -> 1320
  quietEnd      Int?                                  // e.g. 07:00 -> 420
  digestEmail   String   @default("OFF")              // OFF | DAILY | WEEKLY
  pushEnabled   Boolean  @default(true)

  @@id([userId, orgId])
}
```

Pipeline calls `resolveChannels(userId, orgId, type)` → returns the allowed channel set after merging prefs + defaults. Quiet hours apply to **interruptive** channels (email/push) only: if `now` (in user tz) is inside the window, set `NotificationDelivery.scheduledFor` to `quietEnd` and let the worker release it — in-app always lands immediately. Critical types (e.g. none in CRM today, but the hook exists) may bypass. ([SuprSend — batching/digest best practices](https://docs.suprsend.com/docs/best-practices-for-batching-digest), [Courier — notification center best practices](https://www.courier.com/guides/how-to-build-a-notification-center/chapter-3-best-practices-for-notification-centers))

**Reference evidence.** Knock's PreferenceSet model (channel_types vs workflows/categories, "channel preferences take precedence," send only if *all* evaluate true) is the blueprint for the merge/precedence logic. ([Knock preferences](https://docs.knock.app/preferences/overview), [Knock send-and-manage preferences](https://docs.knock.app/send-and-manage-data/preferences)) Quiet-hours/DND windows that queue non-urgent notifications and release them later are an established pattern. ([Upstat — alert suppression](https://upstat.io/blog/alert-suppression-best-practices))

**Effort:** **M** (2 models + resolver + tz/quiet-hours math + a settings UI surface owned by frontend). **Deps:** #1.
**Tier:** **Foundation.**

---

### 3. Event-driven generation pipeline via transactional outbox
**What it enables:** Domain mutations emit events atomically with their data write; notifications are generated reliably and asynchronously, so a Resend/Pusher hiccup never breaks a deal save and no notification is silently lost.

**Design.** Add a `NotificationEvent` outbox table written **in the same Prisma transaction** as the domain change (solves the dual-write problem — DB write and "publish" commit together). A Vercel Cron route (~every minute) drains `PENDING` events and runs the pipeline; for higher throughput / instant delivery, the drain handler hands each event to QStash which calls an internal generation route with retries. ([AWS — transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [Milan Jovanović — implementing the outbox](https://www.milanjovanovic.tech/blog/implementing-the-outbox-pattern))

```prisma
model NotificationEvent {
  id          String   @id @default(cuid())
  orgId       String
  type        NotificationType
  actorId     String?
  entityType  String?
  entityId    String?
  payload     Json                                    // everything the resolver needs
  status      String   @default("PENDING")            // PENDING | PROCESSING | DONE | FAILED
  attempts    Int      @default(0)
  dedupeKey   String?                                 // see #4
  createdAt   DateTime @default(now())
  processedAt DateTime?

  @@index([status, createdAt])
  @@unique([dedupeKey])                                // dedupe at ingest
}
```

Pipeline per event: `(1) resolve recipients` (e.g. ASSIGNMENT → assignee; MENTION → mentioned users; TASK_DUE → activity owner; DEAL_WON → owner + org admins) → `(2) for each recipient apply preferences (#2) + dedup/rate-limit (#4)` → `(3) create Notification + per-channel NotificationDelivery` → `(4) dispatch` (in-app realtime now; email/push now or deferred to digest/quiet). Emit helper lives next to existing actions, e.g. `await db.notificationEvent.create({...})` appended inside `createDeal`/`moveDealToStage`/`toggleActivityComplete` (`src/server/actions/deals.ts`, `activities.ts`).

A thin, typed `emitEvent(tx, {...})` wrapper in `src/lib/notifications/` keeps call sites one-liners and centralizes payload shape. This is the **eventing capability** the brief references — outbox is the integration point other domains publish to.

**Reference evidence.** Transactional outbox is the standard fix for atomic "update DB + publish event," with a relay/poller draining the table (poll-based fits serverless cron cleanly; log-tailing/CDC is the scale-up option). ([AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html), [Conduktor — outbox pattern](https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing), [event-driven.io — push-based outbox](https://event-driven.io/en/push_based_outbox_pattern_with_postgres_logical_replication/)) QStash exists precisely because Vercel functions can't run background processes; it delivers HTTP messages reliably with retries + callbacks. ([Upstash QStash](https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8))

**Effort:** **M** (outbox model + cron drain route + resolver registry + emit wrapper; QStash optional add-on). **Deps:** #1, #2.
**Tier:** **Foundation.**

---

### 4. Deduplication & rate limiting
**What it enables:** Prevents notification storms — bulk-editing 20 deals, a chatty webhook, or an @mention loop won't flood a user; the same logical event won't double-send across a retry.

**Design.** Two layers:
1. **Dedup** — deterministic `dedupeKey = hash(recipientId, type, entityId, bucket)` where `bucket` is a coarse time slice (e.g. 5 min for mentions, 15 min for low-priority per common windows). `@@unique([dedupeKey])` on `NotificationEvent` makes re-emits idempotent (insert conflict = drop). This also makes outbox retries safe.
2. **Rate limit** — per `(recipientId, channel)` cap (e.g. ≤N emails/push per hour). Implement as a small `NotificationRateBucket` counter row (or Upstash Redis `INCR`+EXPIRE if Redis is adopted with QStash). Over-cap interruptive channels get rolled into the next digest (status `DIGESTED`) rather than dropped.

```prisma
model NotificationRateBucket {
  userId     String
  channel    NotificationChannel
  windowKey  String                  // e.g. "2026-06-20T14"  (hour bucket)
  count      Int     @default(0)
  @@id([userId, channel, windowKey])
}
```

Priority-aware windows: medium-priority ~3-5 min dedup + moderate hourly cap; low-priority ~10-15 min + stricter cap; (future) critical bypasses both. ([Upstat — alert suppression best practices](https://upstat.io/blog/alert-suppression-best-practices))

**Reference evidence.** Dedup = suppress identical alerts within a window; rate limiting = cap total per recipient per hour/day; recommended window/cap tiers scale with priority. ([Upstat](https://upstat.io/blog/alert-suppression-best-practices)) Knock's **throttle** function (limit executions over a time window) and idempotency on triggers validate the approach. ([Knock — throttle](https://docs.knock.app/designing-workflows/throttle-function), [Knock — triggering via API](https://docs.knock.app/send-notifications/triggering-workflows/api))

**Effort:** **S** (unique key + one counter model + gate function). **Deps:** #3.
**Tier:** **Core.**

---

### 5. Email delivery via Resend
**What it enables:** Turns on the already-provisioned `RESEND_API_KEY` to send transactional emails (assignment, mention, due-task) and digests with deep links back into the CRM.

**Design.** Add `resend` package; a `sendEmail()` in `src/lib/notifications/email.ts` using `env.RESEND_API_KEY` / `env.EMAIL_FROM` (already in `src/env.ts`). Called by the dispatch step for any `NotificationDelivery(EMAIL)` not deferred. Templates as typed functions (subject + HTML) per `NotificationType`; render from `Notification.data`. Capture Resend message id into `providerId`; mark `SENT`, retry on transient failure via the worker (`attempts`/backoff). Optional later: a `/api/webhooks/resend` route to ingest delivered/bounced/complained events into `NotificationDelivery.status` and auto-suppress hard bounces.

Serverless fit: each send is a short HTTP call inside the generation/digest route — no long-running process. Keep per-invocation send counts bounded (chunk fan-out) to stay within function duration.

**Reference evidence.** Resend is the project's intended provider (env already wired); pattern is a standard transactional-email call from the pipeline. Notification-infra guidance treats email as one channel behind the same preference/digest gate. ([MagicBell — notification system design](https://www.magicbell.com/blog/notification-system-design)) Build-vs-buy note: Knock/Novu deliberately **don't deliver email themselves** — they orchestrate and call providers like Resend, confirming "Resend = delivery, our pipeline = orchestration." ([Knock — how it works](https://docs.knock.app/getting-started/how-knock-works))

**Effort:** **S-M** (mailer + ~5 templates; webhook is a later +S). **Deps:** #1, #3; #2 for opt-outs.
**Tier:** **Core.**

---

### 6. Batching / digests (daily & weekly) with timezone awareness
**What it enables:** Replaces per-event email spam with one rolled-up "here's what happened" email on the user's schedule — the single biggest lever against over-notifying.

**Design.** When prefs say `digestEmail = DAILY|WEEKLY` for a type (or rate-limit overflow from #4), the email delivery is created with `status = DIGESTED` instead of sent. A **Vercel Cron** digest route runs frequently (e.g. hourly) and, for each user whose local digest time has arrived (using `NotificationSettings.timezone`), aggregates that user's `DIGESTED` deliveries since last run into one `DIGEST` notification + one Resend email, then marks them `SENT`. Aggregation can group by `entityType`/`groupKey` ("4 updates on Acme deal"). Vercel Cron triggers the route on schedule; QStash/Inngest is the alternative when sub-minute precision or per-user scheduled fan-out is needed (Inngest natively does "every Monday 9am in tz"). ([Inngest — serverless cron](https://www.inngest.com/uses/serverless-cron-jobs), [Vercel cron via search](https://vercel.com/kb/guide/how-to-setup-cron-jobs-on-vercel))

Batch-window concept (collapse a burst before sending) mirrors Knock's batch step: a window opens on first event and aggregates per `batchKey` (here `groupKey`), with fixed vs sliding windows. We approximate the same with `scheduledFor` + the digest sweep rather than a stateful step engine. ([Knock — batch function](https://docs.knock.app/send-notifications/designing-workflows/batch-function))

**Reference evidence.** Digests group many events into one notification on regular/back-off/scheduled strategies and are the recommended cure for over-notification; urgent items should bypass batching. ([Novu — digest best practices](https://novu.co/blog/digest-notifications-best-practices-example/), [SuprSend — batching & digest](https://docs.suprsend.com/docs/best-practices-for-batching-digest)) Knock's batch window (fixed/sliding, per batch key) is the canonical implementation reference. ([Knock batch](https://docs.knock.app/send-notifications/designing-workflows/batch-function))

**Effort:** **M** (digest cron + aggregation query + tz-window logic + digest template). **Deps:** #2 (tz/prefs), #5 (email), #3.
**Tier:** **Core.**

---

### 7. Real-time in-app delivery (SSE first, Pusher as scale path)
**What it enables:** The notification bell updates live — new items and unread counts appear without a page refresh.

**Design.** **Phase 1 — SSE:** a `GET /api/notifications/stream` Route Handler returns a `text/event-stream`; on a new in-app `Notification`, push an event so the client increments the badge / prepends the item. SSE is one-way (server→client), auto-reconnects, works over plain HTTP, and is the lighter choice for feeds. **Serverless caveat:** Vercel functions are short-lived and **don't support WebSockets**, and SSE connections are long-lived — so on Vercel the pragmatic Phase-1 is **short-poll the unread count every ~30-60s** (trivial, cheap) and treat true SSE as viable only with Fluid Compute / longer max-duration or an edge runtime. **Phase 2 — Pusher (or Ably):** when instant cross-device delivery matters, publish to a per-user channel (`private-user-{id}`) from the dispatch step; the client subscribes. This is exactly Vercel's own recommendation: use a third-party pub/sub for persistent push. ([WebSocket.org — WebSocket vs SSE](https://websocket.org/comparisons/sse/), [Vercel community — WebSocket support](https://github.com/vercel/community/discussions/422))

Decision rule: **poll → SSE → Pusher** as concurrency grows; the dispatch step is identical (it just calls a `realtimePublish(userId, payload)` adapter), so the transport is swappable without touching the pipeline.

**Reference evidence.** SSE suits one-way server push / live feeds, auto-reconnects, and is favored over WebSockets for most subscription use cases; WebSockets are for bidirectional/low-latency. ([WebSocket.org](https://websocket.org/comparisons/sse/)) Serverless functions don't support WebSockets and aren't built for indefinitely-open connections — Vercel points to Pusher Channels for persistent push. ([Vercel community #422](https://github.com/vercel/community/discussions/422))

**Effort:** **S** (poll) / **M** (SSE) / **M** (Pusher integration + secrets). **Deps:** #1, #3.
**Tier:** **Core** (poll/SSE) → **Strategic Bet** (Pusher/realtime infra).

---

### 8. Web push (VAPID + service worker)
**What it enables:** Browser/OS-level push for due-task reminders and assignments even when the CRM tab is closed — re-engagement without email.

**Design.** Generate a VAPID keypair once (`web-push generate-vapid-keys`); store public key in client env, private key as a server secret (add to `src/env.ts`). Client registers a service worker, calls `PushManager.subscribe({ applicationServerKey })`, and POSTs the subscription to a server action that stores it:

```prisma
model PushSubscription {
  id        String   @id @default(cuid())
  userId    String
  endpoint  String   @unique
  p256dh    String
  auth      String
  userAgent String?
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
}
```

Dispatch step for `NotificationDelivery(PUSH)` uses the `web-push` library to send an encrypted payload to each of the recipient's subscriptions; on `410 Gone`/`404`, delete the dead subscription. Gated by prefs (#2) and quiet hours; bounded fan-out per invocation (serverless). ([dsheiko — web push in Next.js](https://dsheiko.com/weblog/how-to-add-web-push-notifications-to-nextjs-app/), [MDN — Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))

**Reference evidence.** Web push = service worker + VAPID keypair + encrypted payloads; the `web-push` package handles encryption/protocol; subscriptions are stored server-side and sent to on events; provider-free (no Resend/FCM needed for desktop browsers). ([Designly — provider-free web push](https://blog.designly.biz/push-notifications-in-next-js-with-web-push-a-provider-free-solution), [HexaCluster — browser push in React/Next](https://hexacluster.ai/blog/implementing-browser-push-notifications-in-reactjs-and-nextjs-with-web-push), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API))

**Effort:** **M** (VAPID + SW + subscription model/actions + send + dead-sub cleanup; iOS Safari needs installed PWA — caveat). **Deps:** #1, #2, #3; frontend SW work.
**Tier:** **Strategic Bet** (highest surface for lowest marginal value in a B2B CRM; do after in-app + email + digests).

---

### 9. Build-vs-buy: notification infrastructure (Knock / Novu / Courier)
**What it enables:** A decision checkpoint — adopt a platform that ships preferences, batching, digests, multi-channel routing, and a prebuilt feed UI, versus the in-house outbox+Prisma design above.

**Design / recommendation.** **Build in-house for Foundation+Core** (#1-#7): the CRM's needs are a handful of event types, three channels, and org-scoped prefs — well within a few Prisma models + cron + Resend, and it keeps notification data co-located with tenant data (clean RBAC, no per-event vendor cost, no PII egress). **Re-evaluate buy at the Strategic-Bet line:** if requirements expand to many event types, visual non-engineer template editing, SMS/Slack/Teams channels, or a drop-in React feed + preference center, a platform pays off.
- **Knock** — best DX; workflow engine with batch/throttle/delay steps, granular PreferenceSets, hosted in-app feed + React components. Orchestrates; you still bring delivery providers (Resend stays). Cloud (usage-priced); not self-hostable. ([Knock](https://docs.knock.app/getting-started/how-knock-works), [Knock — top platforms](https://knock.app/blog/the-top-notification-infrastructure-platforms-for-developers))
- **Novu** — open-source, **self-hostable** (self-host removes per-event cost, ~$50-200/mo infra); workflow engine, subscriber prefs, digest/batch, in-app + 20+ providers. Best fit if data-residency/self-host is a hard requirement. Cloud Indie $25/mo (25k events), Business $200/mo. ([Courier — best notification infra 2025](https://www.courier.com/blog/best-notification-infrastructure-software-2025), [PkgPulse — Novu vs Knock vs Courier](https://www.pkgpulse.com/blog/novu-vs-knock-vs-courier-notification-infrastructure-2026))
- **Courier** — designer-friendly template builder + 50+ providers + strong enterprise/routing; closed-source and the priciest (Pro ~$350/mo) — overkill for current scope. ([Courier blog](https://www.courier.com/blog/best-notification-infrastructure-software-2025), [PkgPulse](https://www.pkgpulse.com/blog/novu-vs-knock-vs-courier-notification-infrastructure-2026))

**Migration safety:** the in-house dispatch step is an adapter (`realtimePublish`, `sendEmail`, resolver registry). If we later buy, the pipeline emits to the vendor's trigger API instead — the `NotificationEvent` outbox already gives us a clean, idempotent hand-off boundary, so the switch is contained.

**Reference evidence.** Vendor matrix: Novu = open-source/self-host; Knock = best DX, orchestration (BYO delivery); Courier = visual/enterprise, highest price. ([PkgPulse — Novu vs Knock vs Courier](https://www.pkgpulse.com/blog/novu-vs-knock-vs-courier-notification-infrastructure-2026), [Courier — best notification infra 2025](https://www.courier.com/blog/best-notification-infrastructure-software-2025), [Knock — top platforms 2026](https://knock.app/blog/the-top-notification-infrastructure-platforms-for-developers))

**Effort:** **S** (decision/spike) now; **L** if a full platform migration is later chosen. **Deps:** informs #1-#8.
**Tier:** **Strategic Bet.**

---

## Effort / tier summary

| # | Capability | Effort | Tier | Key deps |
|---|------------|--------|------|----------|
| 1 | Notification model + in-app feed (seen/read) | S | Foundation | — |
| 2 | Per-user/type/channel preferences + quiet hours | M | Foundation | 1 |
| 3 | Event-driven pipeline (transactional outbox) | M | Foundation | 1, 2 |
| 4 | Deduplication & rate limiting | S | Core | 3 |
| 5 | Email delivery via Resend | S-M | Core | 1, 3 (2) |
| 6 | Batching / digests (daily/weekly, tz-aware) | M | Core | 2, 5 |
| 7 | Real-time in-app (poll → SSE → Pusher) | S/M | Core → Strategic Bet | 1, 3 |
| 8 | Web push (VAPID + service worker) | M | Strategic Bet | 1, 2, 3 |
| 9 | Build-vs-buy (Knock/Novu/Courier) | S (decision) | Strategic Bet | informs all |

**External deps to flag:** `Comment` model + `assignedToId` on Deal/Activity (upstream event sources for MENTION/ASSIGNMENT — do not exist today); QStash or Inngest account if instant/precise scheduling is needed beyond Vercel Cron; Pusher/Ably account for true realtime; service-worker frontend work for web push; new env vars (VAPID keys, optional QStash/Pusher tokens) added to `src/env.ts`.

---

## Top 3 picks

1. **Notification model + in-app feed (#1)** — the keystone everything else hangs off; smallest effort, unlocks the notification center immediately, zero new infra. Pure Foundation.
2. **Event-driven pipeline via transactional outbox (#3)** — makes generation reliable and decoupled from request latency, the right serverless-safe backbone, and the clean hand-off boundary that keeps a future build-vs-buy switch cheap.
3. **Email via Resend (#5) + digests (#6)** — activates the already-provisioned `RESEND_API_KEY` for real reach beyond the tab, and digests are the single biggest guard against over-notifying; ship email first, fold in the digest sweep right behind it.
