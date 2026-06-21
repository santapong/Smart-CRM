# Smart-CRM — Real-time & Live Collaboration Backend Design Brief

**Author:** Backend/Platform Engineer · **Date:** 2026-06-20
**Scope:** Live updates (Kanban board, lists, notifications), presence/typing, concurrent-edit handling — on a **serverless** Vercel stack.

---

## Context & the central constraint

Smart-CRM runs on **Vercel serverless** (Next.js 15, Prisma 5.22, Postgres 16, NextAuth v5 JWT sessions, single region `iad1` per `vercel.json`). Mutations happen in **server actions** (`src/server/actions/deals.ts`) that write via Prisma and call `revalidatePath("/deals")`. The Kanban board (`src/app/(app)/deals/kanban.tsx`, `@dnd-kit`) is a `"use client"` component seeded from server data; on drop it does an optimistic local `setDeals(...)`, calls `moveDealToStage`, then `router.refresh()`.

**Confirmed gaps in the current code:**
- **No fan-out.** `revalidatePath` + `router.refresh()` only re-fetch for *the acting user*. User B sees nothing until they reload. There is no websocket, SSE, polling, or pub/sub anywhere in the repo (grep for `pusher|ably|supabase realtime|socket|EventSource|presence` returns nothing in `src/`).
- **No presence.** No "who's viewing this deal", no avatars, no typing indicator.
- **No optimistic concurrency.** `Deal` has an `@updatedAt` column (`prisma/schema.prisma:199`) but `updateDeal`/`moveDealToStage` never read or compare it — last write silently wins. Two reps editing the same deal clobber each other.

**Why self-hosted websockets are not viable here (the constraint):** Vercel functions are request-scoped. A `ws` server needs a long-lived process holding sockets in memory across connections — impossible on Functions. Even **SSE** is a dead end for durable presence/fan-out: an SSE response stream is bounded by the function's `maxDuration`, and even on **Fluid Compute** the hard ceiling is **~800s** on Pro/Enterprise ([Vercel changelog](https://vercel.com/changelog/serverless-functions-can-now-run-up-to-5-minutes), [Vercel KB: timeouts](https://vercel.com/kb/guide/what-can-i-do-about-vercel-serverless-functions-timing-out), [Vercel community: SSE limits](https://community.vercel.com/t/sse-time-limits/5954)). Clients would silently drop every ~13 min and you'd still need a separate hub to fan messages *between* function invocations. SSE can serve a single-client one-shot stream, but it cannot be the collaboration substrate.

**Therefore the architecture is: a managed pub/sub broker (websockets-as-a-service) that the browser connects to directly, with events *published from server actions* over the broker's REST API.** The server action remains the single writer/authority (Prisma is source of truth); the broker is a dumb, authenticated fan-out pipe. This keeps Vercel functions stateless and short-lived.

```
Browser A ──drop──▶ Server Action (Prisma write, OCC check) ──REST publish──▶ Broker ──ws──▶ Browser B, C…
   ▲                                                                                          │
   └───────────────────── ws (subscribe to org/deal channels) ◀──────────────────────────────┘
```

### Service shortlist (evidence-backed)

| Service | Model | Free tier | Backend publish | Presence | Postgres-native | Notes |
|---|---|---|---|---|---|---|
| **Pusher Channels** | Connection-based quota | 100 conns / 200k msgs-day ([Pusher pricing](https://pusher.com/channels/pricing/), [Ably:Pusher pricing](https://ably.com/topic/pusher-pricing)) | `pusher.trigger()` REST ([pusher-http-node](https://github.com/pusher/pusher-http-node/blob/master/README.md)) | First-class presence channels ([docs](https://pusher.com/docs/channels/using_channels/presence-channels/)) | No | Simplest mental model; signed channel auth |
| **Ably** | Message-based quota | Higher free limits than Pusher ([Ably vs Pusher](https://ably.com/compare/ably-vs-pusher)) | REST publish | Yes | No | Global edge, ordering/history guarantees; pricier at scale |
| **Supabase Realtime** | Peak-connection quota | 200 concurrent conns / 2M msgs-mo ([Supabase pricing](https://supabase.com/pricing)) | REST `POST /realtime/v1/api/broadcast` ([broadcast docs](https://supabase.com/docs/guides/realtime/broadcast)) | Yes (Broadcast/Presence) | **Yes** (same Postgres) | RLS-on-`realtime.messages` auth ([authz](https://supabase.com/docs/guides/realtime/authorization)) |
| **Liveblocks** | MAU-based | 500 active rooms / 1k notifs-mo ([Liveblocks pricing](https://liveblocks.io/pricing)) | Server SDK | Built-in (cursors/avatars) | No | Collab-first (CRDT storage, Comments); overkill for CRM rows |
| **Convex** | Function-call based | 1M calls-mo ([Convex pricing](https://www.convex.dev/pricing)) | It *is* the backend | Reactive queries | Replaces Postgres | Reactive DB; high lock-in, would supplant Prisma |

**Decision driver:** Smart-CRM already runs Postgres. **Supabase Realtime** lets us keep Prisma + our Postgres while getting a managed websocket fan-out with a clean **server-side REST broadcast** path and **RLS-based channel auth** — no second auth system. We use **Broadcast** (ephemeral, server-published) rather than **Postgres Changes** (CDC) because Supabase itself recommends Broadcast for scale and warns Postgres Changes bottlenecks on the DB's ability to authorize each change ([postgres-changes docs](https://supabase.com/docs/guides/realtime/postgres-changes), [authz blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization)). **Pusher is the recommended fallback** if we want zero coupling to Supabase and the cleanest presence primitive. Both are designed so the browser connects to the broker and the *server action* publishes — the right shape for Vercel.

> Note: `docs/DEPLOY.md` already lists Supabase as a Postgres provider option, so a Supabase project may already be in play — adopting Supabase Realtime could be near-zero new vendor surface.

---

## Capabilities

### 1. Pub/sub fan-out transport (Foundation)
**What it enables:** A managed websocket broker that browsers connect to and that server actions publish to over REST — the substrate every other capability rides on. Replaces the "refresh to see changes" model.

**Design:**
- **Chosen service:** Supabase Realtime **Broadcast** (fallback: Pusher Channels). Browser opens *one* websocket per tab; the server stays stateless.
- **Publish path:** add `src/lib/realtime.ts` exposing `broadcast(topic, event, payload, { excludeSocketId? })`. For Supabase it POSTs to `POST /realtime/v1/api/broadcast` with the service-role key (`super_user: true` bypasses per-message authz for trusted server publishes — [broadcast REST](https://supabase.com/docs/guides/realtime/broadcast), [supabase issue #18756](https://github.com/supabase/supabase/issues/18756)); for Pusher it calls `pusher.trigger(channel, event, data, { socket_id })` ([pusher-http-node](https://github.com/pusher/pusher-http-node/blob/master/README.md)).
- **Wire-up:** each server action publishes *after* a successful Prisma commit. Keep `revalidatePath` (it repairs the actor's RSC cache + serves no-JS fallback); the broadcast handles everyone else. Publish payloads are **thin deltas** (`{type:"deal.moved", dealId, stageId, version}`), not full rows — clients patch local state; cost scales with events, not row size.
- **Env:** extend `src/env.ts` with `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `PUSHER_APP_ID/KEY/SECRET/CLUSTER` + `NEXT_PUBLIC_PUSHER_KEY`).

**Reference evidence:** [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast) (REST broadcast w/o websocket); [pusher-http-node README](https://github.com/pusher/pusher-http-node/blob/master/README.md) (`trigger`, max 100 channels/call, batch ≤10); [Vercel timeouts](https://vercel.com/kb/guide/what-can-i-do-about-vercel-serverless-functions-timing-out) (why server must publish, not hold sockets).

**Effort:** **M** — new `realtime.ts` lib, env, broker account, one client provider.
**Deps:** none (this is the base). **Tier:** Foundation.

---

### 2. Live Kanban board sync (Core)
**What it enables:** When rep A drags a deal between stages, reps B/C see the card move within ~1s — no refresh. Directly closes the headline gap.

**Design:**
- **Channel/topic:** `org:{orgId}:deals` (board-scoped, one per org pipeline).
- **Publish:** in `moveDealToStage` / `createDeal` / `updateDeal` / `setDealStatus` / `deleteDeal`, after the Prisma write, call `broadcast("org:"+orgId+":deals", "deal.moved", { dealId, fromStageId, toStageId, version })`. Pass the originating client's `socket_id` so the actor isn't double-notified (they already did the optimistic update) — `socket_id` self-exclusion in `pusher.trigger` / Supabase `self: false` ([pusher-http-node](https://github.com/pusher/pusher-http-node/blob/master/README.md)).
- **Client:** `kanban.tsx` subscribes on mount; on `deal.moved` it reconciles its `deals` state map (the same `setDeals` reducer the drag already uses). For `deal.created`/`deal.deleted`, insert/remove the card. A short fetch-on-event for newly-created cards (to get the full card shape) keeps payloads thin.
- **Ordering:** deltas carry `version` (see #5); a client ignores a delta whose `version` ≤ the version it already has, making out-of-order/duplicate delivery safe (brokers are at-least-once / no strict guarantee — [Supabase: delivery not guaranteed](https://github.com/supabase/realtime)).

**Reference evidence:** [Pusher self-exclusion via socket_id](https://github.com/pusher/pusher-http-node/blob/master/README.md); [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast).

**Effort:** **M** — touch 5 deal actions + subscribe/reconcile in `kanban.tsx`.
**Deps:** #1, #5 (version field). **Tier:** Core.

---

### 3. Live record & list sync (Core)
**What it enables:** Contacts/Companies/Deals list pages and a single Deal detail page (`deals/[id]/page.tsx`) update live as others edit — the generic "any record changed" channel, beyond just the board.

**Design:**
- **Channels:** `org:{orgId}:list:{entity}` for list/index pages (e.g. `org:…:list:contacts`) and `org:{orgId}:record:{entity}:{id}` for a focused detail view.
- **Publish:** generalize the #2 hook into a tiny `publishEntityChange(entity, id, op, version)` helper called from `contacts.ts`, `companies.ts`, `activities.ts`, `deals.ts`. Emits to *both* the list channel and the record channel so list rows and open detail panes both update.
- **Client:** a reusable `useLiveList(entity)` / `useLiveRecord(entity,id)` hook that, on event, either patches in-place or triggers `router.refresh()` for low-frequency entities (cheap, correct, less client reducer code). Use patch for high-traffic Deals, `router.refresh()` for Companies/Contacts.
- **Auth:** same per-org channel auth as #6 — membership in `orgId` gates subscription.

**Reference evidence:** [Supabase Realtime authorization](https://supabase.com/docs/guides/realtime/authorization) (per-topic RLS); [pusher-http-node multi-channel trigger](https://github.com/pusher/pusher-http-node/blob/master/README.md) (one `trigger` can target list+record channels, ≤100 channels).

**Effort:** **M** — one shared publish helper + two client hooks, wired across entity actions.
**Deps:** #1. **Tier:** Core.

---

### 4. Presence — "who's viewing / editing" (Core)
**What it enables:** Avatar stack on a Deal detail / board showing who else is currently looking, so reps don't unknowingly edit the same record. Foundation for typing indicators (#7) and conflict UX (#5).

**Design:**
- **Chosen primitive:** **Pusher presence channels** *or* **Supabase Presence**. Presence channel = `presence-org:{orgId}:deal:{id}` (Pusher) / Supabase Presence on topic `record:deal:{id}`. The broker tracks join/leave and the member roster client-side; no DB writes, no extra Vercel functions.
- **Auth/identity:** on subscribe, the client hits our auth endpoint (#6) which returns a signed token carrying `user_id` + `user_info {name, image}` via `pusher.authorizeChannel(socketId, channel, presenceData)` ([pusher-http-node](https://github.com/pusher/pusher-http-node/blob/master/README.md)). The roster is then maintained entirely by the broker.
- **Server fan-in (optional):** if the server needs to *know* presence (e.g. "lock indicator", analytics), enable **Pusher webhooks** for `member_added`/`member_removed`/`channel_occupied`, POSTed to a Next.js route handler that verifies the Pusher signature ([Pusher webhooks](https://pusher.com/docs/channels/server_api/webhooks/)). Not required for the avatar UI — that's pure client roster.
- **Serverless fit:** presence state lives in the broker, not in a Vercel process — exactly why this works where a self-hosted `ws` roster would not.

**Reference evidence:** [Pusher presence channels](https://pusher.com/docs/channels/using_channels/presence-channels/) (roster, member events); [Pusher webhooks `member_added`/`member_removed`](https://pusher.com/docs/channels/server_api/webhooks/); [Supabase Presence](https://supabase.com/docs/guides/realtime/presence).

**Effort:** **M** — auth endpoint returns presence data + avatar stack component + subscribe.
**Deps:** #1, #6. **Tier:** Core.

---

### 5. Optimistic concurrency control + conflict resolution (Foundation)
**What it enables:** Two reps editing the same deal no longer silently clobber each other; the second save is rejected with a clear "this record changed — reload/merge" instead of last-write-wins. Also the monotonic `version` that makes #2/#3 delta ordering safe.

**Design:**
- **Schema:** add `version Int @default(0)` to `Deal` (and later Contact/Company) in `prisma/schema.prisma`. (`@updatedAt` exists but is a timestamp — clock-/precision-fragile for OCC; an integer `version` is the robust token. We *also* surface `updatedAt` to clients for "edited 2m ago".)
- **Write path (compare-and-swap via `updateMany`):**
  ```ts
  const res = await db.deal.updateMany({
    where: { id, orgId, version: expectedVersion },     // CAS guard
    data:  { ...fields, version: { increment: 1 } },
  });
  if (res.count === 0) return fail("conflict");          // someone else won
  ```
  `updateMany` returns `count: 0` on version mismatch — the canonical Prisma OCC signal ([Prisma OCC discussion #10250](https://github.com/prisma/prisma/discussions/10250), [Prisma issue #4988](https://github.com/prisma/prisma/issues/4988)). The deal form must round-trip the loaded `version` as a hidden field; `dealSchema` in `deals.ts` gains `version: z.coerce.number().int()`.
- **Conflict resolution UX:** on `fail("conflict")`, the client (which already shows `r.error` via `toast.error` in `kanban.tsx`) shows "This deal was updated by {presence name}. Reload to see the latest." For the board's stage-move, conflicts are rare and the safe resolution is *refetch + re-apply*, since stage is a single field (last-mover-wins is acceptable *once detected*). For detail-form field edits, offer reload (v1) → field-level merge (later).
- **Realtime tie-in:** the incremented `version` is what every broadcast delta carries (#2/#3), so clients can drop stale/duplicate events deterministically.

**Reference evidence:** [Prisma OCC with version + `updateMany` count===0](https://github.com/prisma/prisma/discussions/10250); [Prisma transactions/CAS](https://www.prisma.io/docs/orm/prisma-client/queries/transactions); [Prisma issue #4988 OCC](https://github.com/prisma/prisma/issues/4988).

**Effort:** **S–M** — migration + change `updateDeal`/`moveDealToStage` to `updateMany` CAS + form hidden field + toast copy. (S for Deal; M to roll across entities.)
**Deps:** none for the DB part; pairs with #2/#3 for delta ordering. **Tier:** Foundation.

---

### 6. Channel authorization & multi-tenant scoping (Foundation)
**What it enables:** A user can only subscribe to channels for *their* org and records they may see — no cross-tenant leakage over the realtime layer. Without this, realtime is a tenant-isolation hole.

**Design:**
- **Auth endpoint:** a Next.js route handler `POST /api/realtime/auth` that calls `requireOrg()` (from `src/lib/tenant.ts`, returns `{userId, orgId, role}` off the NextAuth JWT). It validates the requested channel: the channel name must start with `org:{session.orgId}:` (and for record channels, optionally a `db.deal.findFirst({where:{id,orgId}})` existence check). Only then sign the subscription.
  - **Pusher:** return `pusher.authorizeChannel(socketId, channel, presenceData)` ([pusher-http-node](https://github.com/pusher/pusher-http-node/blob/master/README.md)).
  - **Supabase:** issue/validate a Realtime-scoped token and set the channel `private`, with **RLS policies on `realtime.messages`** restricting reads/writes to topics matching the user's org ([Supabase authz](https://supabase.com/docs/guides/realtime/authorization), [authz blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization)).
- **Channel naming convention (single source of truth in `realtime.ts`):**
  - `org:{orgId}:deals` — board
  - `org:{orgId}:list:{entity}` — list pages
  - `org:{orgId}:record:{entity}:{id}` — detail
  - `presence-org:{orgId}:deal:{id}` — presence (Pusher prefix-mandated)
- **Scaling channels:** one board channel + one channel per *actively-viewed* record. Connections (the billed unit for Pusher/Supabase) scale with concurrent *tabs*, not orgs — a 20-seat org with 5 tabs open = 5 connections, well within free tiers. Message volume scales with edit frequency × subscribers, mitigated by thin deltas (#1) and `socket_id` self-exclusion (#2).

**Reference evidence:** [Pusher authorizing private/presence channels](https://github.com/pusher/pusher-http-node/blob/master/README.md); [Supabase Realtime authorization (RLS on realtime.messages)](https://supabase.com/docs/guides/realtime/authorization); [Supabase Broadcast/Presence authz blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization).

**Effort:** **M** — auth route + channel-name validator + (Supabase) RLS policy migration.
**Deps:** #1; reuses existing `requireOrg()`. **Tier:** Foundation.

---

### 7. Typing / live-edit indicators (Strategic Bet)
**What it enables:** "Jane is editing the Notes…" on the Deal detail form — pre-emptive conflict avoidance that complements OCC (#5).

**Design:**
- **Transport:** pure **client→client Broadcast** on the record channel (`record:deal:{id}` / presence channel) — *no server action, no Prisma write*. The editing client emits a throttled `typing` broadcast (debounced ~2s, auto-expire). This is the textbook "ephemeral message" use of Broadcast ([Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast)).
- **Why client-published here:** typing is high-frequency and disposable; routing it through a Vercel function would burn invocations for nothing. Supabase allows client broadcast on an authorized private channel; Pusher uses **client events** (`client-typing`, must be enabled per-app, only on private/presence channels) — both gate on the #6 auth.
- **Conflict tie-in:** combine with presence (#4) so the form can disable/warn on a field another user is actively typing into, reducing #5 conflicts before they happen.

**Reference evidence:** [Supabase Broadcast (ephemeral client messages)](https://supabase.com/docs/guides/realtime/broadcast); [Pusher presence + client events](https://pusher.com/docs/channels/using_channels/presence-channels/).

**Effort:** **M** — throttled emit + transient UI; depends on presence plumbing.
**Deps:** #4, #6. **Tier:** Strategic Bet.

---

### 8. Realtime notifications + delivery model (Strategic Bet)
**What it enables:** A live bell/toast ("You were assigned a deal", "Activity due") that appears without refresh, plus a durable inbox so events aren't lost when the user is offline.

**Design:**
- **Schema (durability):** add a `Notification` model (`id, orgId, userId, type, payload Json, readAt, createdAt`, index `@@index([userId, readAt])`). The broker is best-effort/at-least-once and explicitly **does not guarantee delivery** ([Supabase](https://github.com/supabase/realtime)) — so the DB row is the source of truth and realtime is the *live nudge*.
- **Channel:** per-user `org:{orgId}:user:{userId}` (or Pusher presence for unread badge counts).
- **Flow:** server action that triggers a notification (e.g. assign deal owner in `updateDeal`) writes the `Notification` row **then** `broadcast("…:user:"+userId, "notification", {id, type})`. Client appends to the bell; on reconnect it reconciles by fetching unread rows (covers any missed broadcasts).
- **Fan-out efficiency:** target the specific user channel, not the org, to avoid every member receiving every notification (keeps message count — the billed unit — low).

**Reference evidence:** [Supabase delivery-not-guaranteed → need DB durability](https://github.com/supabase/realtime); [pusher-http-node per-channel trigger](https://github.com/pusher/pusher-http-node/blob/master/README.md).

**Effort:** **L** — new model + migration + write-then-publish in relevant actions + bell UI + reconcile-on-reconnect.
**Deps:** #1, #6. **Tier:** Strategic Bet.

---

## Cost summary (entry tiers)

For Smart-CRM's scale (small-team CRM, connections = concurrent open tabs):
- **Supabase Realtime:** Free = 200 concurrent conns / 2M msgs-mo; Pro $25/mo bundles 500 conns + the DB you already pay for — **likely $0 incremental if already on Supabase Postgres** ([pricing](https://supabase.com/pricing)).
- **Pusher:** Free Sandbox 100 conns / 200k msgs-day; first paid Startup **$49/mo** (500 conns / 1M msgs-day) ([pricing](https://pusher.com/channels/pricing/), [Ably:Pusher](https://ably.com/topic/pusher-pricing)).
- **Ably:** more generous free tier, message-billed, ~$49.99/mo entry ([Ably vs Pusher](https://ably.com/compare/ably-vs-pusher)) — best if global low-latency matters.
- **Liveblocks** ($20/mo, 1k MAU) and **Convex** (1M calls free) are priced for *collab-document* / *reactive-DB* products, not row-level CRM fan-out — adopting either means a larger paradigm shift (CRDT store / replacing Prisma).

---

## Top 3 picks

1. **Pub/sub fan-out transport (#1, Foundation)** — the serverless-correct base: browsers connect to a managed broker (Supabase Realtime, fallback Pusher), server actions publish thin deltas via REST after Prisma commit. Everything else depends on it.
2. **Optimistic concurrency control + conflict resolution (#5, Foundation)** — add `version Int`, switch deal writes to `updateMany` compare-and-swap (`count===0` ⇒ conflict), surface a clear conflict toast. Stops silent clobbering *and* makes realtime delta ordering safe. Cheap, high-value, no vendor needed.
3. **Live Kanban board sync (#2, Core)** — the headline feature: drag-to-move propagates to other reps in ~1s by reconciling broadcast deltas into the existing `kanban.tsx` `setDeals` reducer, with `socket_id` self-exclusion. Directly closes the "changes don't appear for others" gap.
