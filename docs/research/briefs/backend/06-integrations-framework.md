# Smart-CRM — Integrations Framework & Sync Engine (Design Brief)

**Author:** Backend/Platform engineering
**Date:** 2026-06-20
**Scope:** The internal plumbing to build and run third-party connectors — OAuth token storage/refresh, a connector SDK/abstraction, two-way sync engine, conflict resolution, scheduling on serverless, idempotency/dedup, and a unified-API option. A separate marketing agent decides *which* integrations to build; this brief designs the *framework* that powers them.

---

## 0. Current state (what we have / what's missing)

Read of the repo (`prisma/schema.prisma`, `src/lib/*`, `src/server/actions/*`):

- **Stack:** Next.js 15.0.3 (App Router, RSC + server actions), Prisma 5.22, Postgres, NextAuth v5 (`5.0.0-beta.25`) with JWT sessions + Prisma adapter, deployed on Vercel (serverless).
- **Multi-tenancy:** `Organization` ← `Membership` (role `OWNER`/`ADMIN`/`MEMBER`) ← `User`. Every CRM row is `orgId`-scoped. Access is gated by `requireOrg()` / `requireRole()` (`src/lib/tenant.ts`, `src/lib/rbac.ts`). **Any integration data MUST be `orgId`-scoped the same way.**
- **`Account` model (`schema.prisma:28`):** stores NextAuth *login* identities — `provider`, `providerAccountId`, `refresh_token`/`access_token`/`expires_at`/`scope` as **plaintext** `@db.Text`. This is the NextAuth adapter table; it is **not** a place to build outbound integrations on (it's keyed to the login user, tokens are unencrypted, and the schema is owned by the adapter). We introduce a separate `Connection` model.
- **Gaps confirmed:** no outbound OAuth app framework, no token encryption, no token refresh, no sync/ETL engine, no job runner/queue, no scheduling. `src/env.ts` (t3-env) has no encryption key var yet.

**Two strategic decisions frame everything below:**

1. **Buy the OAuth/connector substrate, build the CRM mapping.** Writing and maintaining N OAuth flows + token refresh + delta-sync scripts per provider is the expensive, low-differentiation part. Recommendation: adopt **Nango** as the connector substrate (managed OAuth + token refresh + sync runner running on *Nango's* infra, which sidesteps Vercel function timeouts), and keep our own normalization/upsert layer. Keep **Merge.dev** as the fast path for the CRM-import category specifically, and treat **native connectors** as the escape hatch. (Build-vs-buy detail in §8.)
2. **Run the sync orchestration on a durable job runner, not raw Vercel cron.** Vercel Hobby crons are once-per-day only and functions cap at 300s default / 800s max even with Fluid compute — too tight for multi-account full syncs. Use a stepped/retrying job runner (Inngest recommended) triggered by cron/webhook. (Detail in §4 and cross-ref the separate "jobs capability" brief.)

The capabilities below are ordered so each builds on the previous. Effort is S (≤2 days), M (~1 week), L (multi-week).

---

## 1. Secure OAuth Token Vault (encryption at rest)

**(1) What it enables.** A single, encrypted home for every third-party credential (OAuth access/refresh tokens, API keys) so a DB dump never leaks usable secrets, and so we can rotate the encryption key without re-authing users. Foundation for *everything* else.

**(2) Design.** AES-256-GCM (authenticated encryption) via Node's built-in `crypto`, envelope pattern: a per-record random **96-bit IV**, the **authTag**, and a **keyId** stored alongside ciphertext so we can rotate keys. The data-encryption key (DEK) comes from an env var today (`TOKEN_ENC_KEY`, 32 bytes base64), upgradeable to a KMS-wrapped key later without schema change. Tokens are *never* stored plaintext and *never* returned to the client.

```prisma
// New model. NOT the NextAuth `Account` table.
model EncryptedSecret {
  id         String   @id @default(cuid())
  keyId      String   // which DEK version encrypted this (rotation)
  iv         Bytes    // 12-byte random nonce, unique per encryption
  authTag    Bytes    // GCM auth tag
  ciphertext Bytes
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```

```ts
// src/lib/crypto/secrets.ts (sketch)
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
const KEYS: Record<string, Buffer> = { v1: Buffer.from(process.env.TOKEN_ENC_KEY!, "base64") };
const ACTIVE = "v1";
export function seal(plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEYS[ACTIVE], iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { keyId: ACTIVE, iv, authTag: c.getAuthTag(), ciphertext: ct };
}
export function open(s: { keyId: string; iv: Buffer; authTag: Buffer; ciphertext: Buffer }) {
  const d = createDecipheriv("aes-256-gcm", KEYS[s.keyId], s.iv);
  d.setAuthTag(s.authTag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]).toString("utf8");
}
```
Add `TOKEN_ENC_KEY` to `src/env.ts` (`z.string().min(44)` for a base64 32-byte key). **Note:** if we adopt Nango/Merge, the *vendor* holds the tokens and we store only their opaque connection/account token — but we still encrypt *that* token here, and this vault is required the moment we run even one native connector.

**(3) Reference evidence.** OWASP Cryptographic Storage Cheat Sheet recommends AES-256 in an authenticated mode (GCM) as first preference (https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html). Node `crypto` GCM usage + unique-IV-per-encryption (https://nodejs.org/api/crypto.html). Envelope/DEK-KEK key management (https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html). Worked envelope-at-rest example (https://github.com/zachelrath/encrypt-at-rest).

**(4) Effort:** **S.** Deps: none (built-in `crypto`); add one env var.

**(5) Tier:** **Foundation.**

---

## 2. Connection Registry (`Connection` + `Integration` models)

**(1) What it enables.** A tenant-scoped record of "Org X has connected Provider Y," holding status, scopes, the encrypted credential, and (if using a vendor) the vendor connection id. This is the object the UI lists, the sync engine iterates, and RBAC guards.

**(2) Design.** `Integration` = a connector definition (static catalog row: provider key, auth type, capabilities). `Connection` = one org's live link to an integration. Credential lives in `EncryptedSecret` (1:1) for native connectors; for vendor-managed auth, `vendorConnectionId` points at Nango/Merge and `EncryptedSecret` holds only the vendor token.

```prisma
enum ConnectionStatus { PENDING ACTIVE DEGRADED REVOKED ERROR }
enum AuthKind { OAUTH2 OAUTH1 API_KEY BASIC }
enum SyncDirection { INBOUND OUTBOUND BIDIRECTIONAL }

model Integration {            // catalog (seeded, not per-tenant)
  id           String   @id @default(cuid())
  key          String   @unique          // "google-calendar", "gmail", "hubspot"
  displayName  String
  authKind     AuthKind
  capabilities Json                       // { objects: ["contact","event"], directions: [...] }
  managedBy    String                     // "native" | "nango" | "merge"
  connections  Connection[]
}

model Connection {
  id                 String           @id @default(cuid())
  orgId              String                              // TENANT SCOPE — always filter on this
  integrationId      String
  status             ConnectionStatus @default(PENDING)
  direction          SyncDirection    @default(INBOUND)
  externalAccountId  String?                             // provider account / mailbox / portal id
  scopes             String?
  vendorConnectionId String?                             // Nango connectionId / Merge linked-account id
  secretId           String?          @unique            // -> EncryptedSecret
  expiresAt          DateTime?                           // access-token expiry (for native refresh)
  lastError          String?
  createdById        String
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt

  org         Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  integration Integration      @relation(fields: [integrationId], references: [id])
  secret      EncryptedSecret? @relation(fields: [secretId], references: [id])
  syncStates  SyncState[]

  @@unique([orgId, integrationId, externalAccountId])    // one link per mailbox/account per org
  @@index([orgId, status])
}
```
Add the inverse `connections Connection[]` relation to `Organization`. Access is gated exactly like CRM data: server actions call `requireOrg()` and `requireRole(role, "ADMIN")` for connect/disconnect (members can't manage org integrations).

**(3) Reference evidence.** Mirrors how vendors model this: Nango stores credentials per *connection* under an *integration* and exposes `getConnection(integrationId, connectionId)` (https://docs.nango.dev/reference/api/connection/get); Merge issues a permanent **`account_token`** per **Linked Account** that you persist in your DB (https://docs.merge.dev/basics/authentication/). Tenant-scoping pattern follows the repo's existing `orgId` convention (`src/lib/tenant.ts`).

**(4) Effort:** **S.** Deps: §1 (secret vault).

**(5) Tier:** **Foundation.**

---

## 3. OAuth Token Lifecycle: refresh with single-flight locking

**(1) What it enables.** Always-valid access tokens for native connectors, refreshed proactively, with safe behavior under concurrent serverless invocations (no "refresh stampede" that revokes a token family).

**(2) Design.** A `getValidAccessToken(connectionId)` helper: decrypt the credential; if `expiresAt` is within a 5-minute skew, refresh. **Concurrency:** serverless means many functions may try to refresh the same connection at once. Guard with a Postgres advisory lock (single-flight) so exactly one refresh runs; losers wait and re-read the freshly stored token.

```ts
// src/lib/integrations/token.ts (sketch)
export async function getValidAccessToken(connId: string) {
  const conn = await db.connection.findUniqueOrThrow({ where: { id: connId }, include: { secret: true } });
  const cred = JSON.parse(open(conn.secret!)); // { access_token, refresh_token, ... }
  if (conn.expiresAt && conn.expiresAt.getTime() - Date.now() > 5 * 60_000) return cred.access_token;

  // single-flight: hash connId -> bigint key for pg_advisory_xact_lock
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${connId}, 0))`;
    const fresh = await tx.connection.findUniqueOrThrow({ where: { id: connId }, include: { secret: true } });
    const c = JSON.parse(open(fresh.secret!));
    if (fresh.expiresAt && fresh.expiresAt.getTime() - Date.now() > 5 * 60_000) return c.access_token; // someone refreshed
    const next = await refreshWithProvider(c.refresh_token); // provider-specific
    await tx.encryptedSecret.update({ where: { id: fresh.secretId! }, data: seal(JSON.stringify({ ...c, ...next })) });
    await tx.connection.update({ where: { id: connId }, data: { expiresAt: new Date(Date.now() + next.expires_in * 1000), status: "ACTIVE" } });
    return next.access_token;
  });
}
```
On refresh failure (revoked grant) → set `status = REVOKED`, surface re-auth prompt in UI. **If we use Nango/Merge, this entire capability is delegated** — Nango auto-refreshes tokens at least once/24h and dedupes concurrent refreshes server-side; we just call `getConnection`. Build §3 only for native connectors.

**(3) Reference evidence.** RFC 9700 (OAuth 2.0 Security BCP, Jan 2025) on refresh-token rotation/sender-constraint (https://datatracker.ietf.org/doc/html/rfc9700). Token-family revocation on reuse (https://workos.com/blog/oauth-best-practices). Refresh stampede + locking/single-flight (https://www.alexgaio.com/post/lock-free-client-side-concurrent-refresh-token-redemptions-with-asp-net-core). Nango managed refresh + concurrency handling (https://nango.dev/blog/concurrency-with-oauth-token-refreshes/, https://docs.nango.dev/reference/api/connection/get). Note Google does **not** rotate refresh tokens by default, lowering stampede risk for Gmail/Calendar, but the lock still prevents redundant grants.

**(4) Effort:** **M** (native path) / **S** (if delegated to Nango). Deps: §1, §2.

**(5) Tier:** **Foundation.**

---

## 4. Sync Scheduling on serverless (cron → durable job runner)

**(1) What it enables.** Periodic, reliable kick-off of per-connection syncs without blowing serverless time limits or losing work on a cold timeout.

**(2) Design.** **Do not** run syncs directly inside a Vercel cron function. Pattern: a lightweight cron (Vercel cron or QStash schedule) calls a "fan-out" endpoint that enqueues **one job per active `Connection`** into a durable, stepped job runner (**Inngest** recommended). Each job is small, retried per-step, and idempotent. Inngest functions run as HTTP handlers (Vercel-friendly), with managed retries, concurrency limits, and schedules — no Redis/worker fleet to operate.

```jsonc
// vercel.json — Pro plan needed for sub-daily cadence (Hobby = daily only)
{ "crons": [ { "path": "/api/sync/dispatch", "schedule": "*/15 * * * *" } ] }
```
```ts
// /api/sync/dispatch -> emit one Inngest event per connection (fast, returns immediately)
for (const c of activeConnections) await inngest.send({ name: "sync/connection.run", data: { connectionId: c.id } });
// Inngest fn "sync/connection.run": stepped — refresh token -> pull deltas -> upsert -> save watermark
```
Chunk large pulls across steps/invocations rather than one long function. Crucially, if we use **Nango**, the heavy sync *runs on Nango's infra* and merely POSTs us a sync webhook; our job then calls `listRecords` (short calls), which fits Vercel limits comfortably. This capability **depends on the separate "jobs/queue" platform brief** — align the runner choice there.

**(3) Reference evidence.** Vercel cron config + Hobby daily-only limit (https://vercel.com/docs/cron-jobs, https://vercel.com/docs/cron-jobs/usage-and-pricing). Function duration 300s default / up to 800s Fluid, 100 crons/project (https://vercel.com/docs/functions/configuring-functions/duration, https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan). Inngest step functions + retries + schedules, no Redis (https://www.inngest.com/docs/learn/how-functions-are-executed). Alternatives: Trigger.dev (https://trigger.dev/docs), QStash schedules (https://upstash.com/docs/qstash); BullMQ needs persistent Redis so it's a poor serverless fit (https://docs.bullmq.io). Nango runs syncs on its infra and webhooks your app (https://nango.dev/docs/guides/functions/syncs/sync-functions).

**(4) Effort:** **M.** Deps: §2, the jobs platform, a runner account (Inngest).

**(5) Tier:** **Core.**

---

## 5. Connector Interface / SDK (auth · fetch · map · upsert)

**(1) What it enables.** A uniform contract so every connector — native, Nango-backed, or Merge-backed — looks the same to the sync engine. Adding a provider becomes "implement one interface," not "rewire the engine."

**(2) Design.** Four-stage contract: **auth** (get a valid client/token), **fetch** (pull a page of external records given a watermark/cursor), **map** (external → our canonical CRM shape), **upsert** (write into Smart-CRM, `orgId`-scoped, idempotent). The same interface, run in reverse with `outbound()`, powers two-way sync.

```ts
// src/lib/integrations/connector.ts (sketch)
export interface ExternalRecord { externalId: string; updatedAt: Date; deleted?: boolean; raw: unknown; }
export interface FetchResult { records: ExternalRecord[]; nextCursor?: string; nextWatermark?: string; fullResyncRequired?: boolean; }

export interface Connector<TObj extends string = string> {
  key: string;                                   // "google-calendar"
  objects: TObj[];                               // ["event"] | ["contact","company"]
  auth(conn: Connection): Promise<AuthCtx>;      // -> token/client (uses §3)
  fetch(ctx: AuthCtx, obj: TObj, cursor?: string): Promise<FetchResult>;   // delta pull
  map(obj: TObj, ext: ExternalRecord, orgId: string): CanonicalUpsert;     // normalize
  upsert(orgId: string, u: CanonicalUpsert): Promise<{ id: string; changed: boolean }>; // idempotent write (§6)
  outbound?(ctx: AuthCtx, obj: TObj, local: CanonicalUpsert): Promise<{ externalId: string }>; // write-back
}
```
`CanonicalUpsert` is a discriminated union over our domain (`{ object: "contact", data: ContactInput, externalId }`, etc.). `map` is the only provider-specific glue; `upsert` is shared (one per CRM object). A `NangoConnector` adapter implements `fetch` via `nango.listRecords` and `map` from Nango records; a `MergeConnector` reads Merge's normalized models — so the engine is vendor-agnostic.

**(3) Reference evidence.** The auth/fetch/map/upsert decomposition mirrors Nango sync scripts (handle pagination/incremental/dedup, write to a records cache; you map raw → your model) (https://nango.dev/docs/guides/functions/syncs/sync-functions) and Merge's normalized common models (Account/Contact/Lead/Opportunity) read through one API (https://docs.merge.dev/crm/overview/). Passthrough/Proxy give the escape hatch for non-normalized endpoints (https://docs.merge.dev/supplemental-data/passthrough/, https://nango.dev/docs/guides/primitives/auth).

**(4) Effort:** **M.** Deps: §2, §3.

**(5) Tier:** **Core.**

---

## 6. Incremental two-way sync engine: watermarks, idempotency, dedup

**(1) What it enables.** Pull only what changed since last run (cheap, fast), apply it exactly once, and never duplicate records on retries or overlapping runs — in both directions.

**(2) Design.** Per `(Connection, object)` we persist a **`SyncState`** holding the high-water-mark / provider cursor (e.g. Gmail `historyId`, Calendar `nextSyncToken`, or a generic `updatedAt` timestamp). The engine loop: read watermark → `fetch` deltas → for each record `upsert` keyed on **external id** (last-write-wins by `updatedAt`) → record an **`IdempotencyKey`** so re-delivery is a no-op → advance watermark **only after** the page commits. On a `404`/`410` "sync token invalid" → set `fullResyncRequired` and reset the watermark.

```prisma
model SyncState {
  id              String    @id @default(cuid())
  connectionId    String
  object          String                       // "event" | "contact"
  watermark       String?                       // historyId / nextSyncToken / ISO ts
  cursor          String?                       // in-progress pagination cursor
  lastSyncedAt    DateTime?
  lastStatus      String?                       // OK | PARTIAL | FULL_RESYNC | ERROR
  conn            Connection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@unique([connectionId, object])
}

// Maps an external record to our row + dedups (idempotency)
model ExternalLink {
  id           String   @id @default(cuid())
  orgId        String
  connectionId String
  object       String                          // "contact"
  externalId   String                          // provider id
  localId      String                          // our Contact.id etc.
  sourceHash   String                          // hash of last-synced payload -> skip no-op writes
  externalUpdatedAt DateTime?
  updatedAt    DateTime @updatedAt
  @@unique([connectionId, object, externalId]) // dedup key (inbound)
  @@index([orgId, object, localId])            // reverse lookup for outbound
}
```
**Conflict resolution (two-way).** Both sides can change a record between syncs. Strategy, in order: (a) **field-level last-write-wins** by comparing `externalUpdatedAt` vs our `updatedAt`; (b) for connectors that support it, a **source-of-truth per object** policy (e.g. "calendar events: provider wins; CRM notes: Smart-CRM wins") configured on `Integration.capabilities`; (c) on true concurrent edits of the same field, **keep both + flag** by writing a lightweight `SyncConflict` row for human review rather than silently clobbering. Outbound writes use the same `ExternalLink` to find the external id and an idempotency token so a retried write-back doesn't create duplicates. **Loop prevention:** when we write a record we received from a provider, stamp `sourceHash`; on the next inbound pull, if the incoming hash equals the stored `sourceHash`, skip — this stops echo loops in bidirectional sync.

**(3) Reference evidence.** High-water-mark incremental load (https://support.etlworks.com/hc/en-us/articles/360014718933-Change-Replication-using-High-Watermark-HWM, https://blog.skyvia.com/incremental-load-strategy-for-data-warehouses/). Gmail `historyId` delta sync, invalid id → 404 → full sync (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list). Google Calendar `nextSyncToken`, invalid → **410 GONE** → full resync (https://developers.google.com/workspace/calendar/api/guides/sync). Idempotency/dedup on stable external id + upsert + TTL (https://stripe.com/docs/idempotency, https://hookdeck.com/webhooks/guides/implement-webhook-idempotency, https://www.hooklistener.com/learn/webhook-idempotency-and-deduplication). Nango handles pagination/incremental/dedup and exposes `_nango_metadata` (`last_modified_at`, `deleted_at`) + cursor (https://docs.nango.dev/guides/syncs/use-a-sync).

**(4) Effort:** **L** (full two-way + conflicts) / **M** (one-way inbound first). Deps: §3, §4, §5.

**(5) Tier:** **Core** (one-way) → **Strategic Bet** (full bidirectional + conflict UI).

---

## 7. Webhook ingestion & real-time deltas

**(1) What it enables.** Near-real-time sync (and far fewer wasted polls) by reacting to provider/vendor push notifications instead of only scheduled pulls.

**(2) Design.** A signed webhook receiver per source: `/api/integrations/webhooks/[source]`. It (a) **verifies signature** (HMAC per provider / Nango / Merge), (b) writes a raw `WebhookEvent` row and returns `200` fast, (c) enqueues an Inngest event to process asynchronously (same job path as §4/§6). Dedup on the provider's event id via `IdempotencyKey`. Nango POSTs a **sync webhook** (counts of added/updated/deleted, `INITIAL` vs `INCREMENTAL`, `modifiedAfter`); Merge fires webhooks on new data. Native Gmail/Calendar use Google Pub/Sub push + watch channels (renewable) — for v1 we can poll on a 15-min cron and add push later.

```prisma
model WebhookEvent {
  id         String   @id @default(cuid())
  source     String                 // "nango" | "merge" | "google"
  externalId String                 // provider event id (dedup)
  payload    Json
  status     String   @default("PENDING") // PENDING | PROCESSED | FAILED
  receivedAt DateTime @default(now())
  @@unique([source, externalId])
}
```

**(3) Reference evidence.** Nango sync webhooks + then pull via `listRecords` (https://docs.nango.dev/reference/sdks/node, https://nango.dev/docs/guides/functions/syncs/sync-functions). Merge webhooks on new data, still poll ~24h as backstop (https://docs.merge.dev/merge-unified/reading-data/syncing-best-practices, https://www.merge.dev/features/real-time-data). Webhook idempotency/verify-then-200-then-process (https://hookdeck.com/webhooks/guides/implement-webhook-idempotency).

**(4) Effort:** **M.** Deps: §4, §6.

**(5) Tier:** **Core.**

---

## 8. Build-vs-Buy: native connectors vs Nango vs Merge.dev vs Paragon

**(1) What it enables.** A deliberate substrate choice so we don't hand-roll OAuth + refresh + delta-sync for every provider, while keeping control of our CRM data model and unit economics.

**(2) Design / recommendation.** Adopt a **two-track strategy**:

| Option | Model | Auth & token refresh | Sync engine | Where data lives | Pricing (approx., 2026) | Fit |
|---|---|---|---|---|---|---|
| **Native** | Write each connector ourselves on §1–§6 | We build (§3) | We build (§6) | Our Postgres | infra only | Max control; max maintenance. Escape hatch only. |
| **Nango** | Open-source **code-first** connector toolkit, ~800+ APIs | **Managed** (auto-refresh ≥1×/24h, concurrency-safe) | **Managed**, runs on Nango infra; webhook + `listRecords` | Nango records cache → we pull into Postgres | Free ~10 conns; Starter ~$19/mo; Growth ~$249/mo; Scale custom | **Primary substrate.** Manages the hard parts, we keep our mapping/upsert. Note: free **self-host = Auth+Proxy only**; managed *syncs* need Cloud/Enterprise. |
| **Merge.dev** | **Unified API** — one normalized schema across many providers; CRM category (Account/Contact/Lead/Opportunity) | Merge Link/Magic Link; we store one `account_token` | Scheduled syncs on Merge infra + webhooks; supports **writes** + **passthrough** | Merge infra → we read normalized | Free first 3 linked accounts; **Launch ~$650/mo** (10 prod), ~$65/extra; Pro/Enterprise custom | **Fast path for the "import my existing CRM" feature** (HubSpot/Salesforce/etc. in one shot). Cost scales per customer connection. |
| **Paragon** | **Embedded iPaaS** — visual workflow builder + Connect Portal, ~130+ connectors, ActionKit (1000+ actions) | **Managed** (fully managed auth, keeps tokens refreshed) | Hosted workflow runtime (triggers/workflows/custom JS steps) | In Paragon workflows; webhooks to us | Sales-led/enterprise (Pro + Enterprise; billed by Connected Users); self-host Enterprise-only | Best if non-engineers must build integrations visually, or for an enterprise embedded-integrations marketplace. Heavier/pricier than we need at this stage. |

**Recommendation:** **Nango as the default connector substrate** (keeps our data model + economics sane while killing the OAuth/refresh/sync toil), **Merge.dev specifically for the bulk "connect your existing CRM" import** (its normalized CRM models are exactly that job), and a **thin native connector path** for anything strategic/not covered (e.g. a deep Gmail/Calendar two-way that we want full control over). Build §1–§6 regardless — they're what we plug any of these into, and they're the only way native connectors exist.

**(3) Reference evidence.** Nango positioning/self-host/refresh/syncs/pricing (https://github.com/NangoHQ/nango, https://nango.dev/docs/guides/platform/self-hosting, https://github.com/NangoHQ/nango/issues/5536, https://docs.nango.dev/reference/api/connection/get, https://nango.dev/pricing/). Merge unified API + CRM models + Link + writes/passthrough + pricing (https://docs.merge.dev/crm/overview/, https://docs.merge.dev/get-started/link/, https://docs.merge.dev/supplemental-data/passthrough/, https://www.merge.dev/pricing, https://www.nango.dev/blog/merge-pricing). Paragon embedded iPaaS + Connect Portal + managed auth + workflows/ActionKit + hosting + pricing (https://www.useparagon.com/connect-portal, https://www.useparagon.com/authentication, https://docs.useparagon.com/workflows/building-workflows, https://www.useparagon.com/hosting-options, https://www.merge.dev/blog/paragon-pricing).

**(4) Effort:** **S** (decision + spike one vendor) per track; full native is **L**.

**(5) Tier:** **Strategic Bet** (the substrate choice shapes the roadmap).

---

## 9. Reference connector end-to-end: Google Calendar (two-way)

**(1) What it enables.** A concrete, shippable proof of the whole framework: connect a Google account, sync calendar events into Smart-CRM `Activity` rows (type `MEETING`), and write CRM-created meetings back to Google — exercising auth, delta sync via `nextSyncToken`, idempotency, and conflict handling.

**(2) Design (flow).**
1. **Connect.** Admin clicks "Connect Google Calendar." Either Nango's frontend SDK or our native OAuth route runs the consent flow (scope `calendar.events`). On callback we create a `Connection` (org-scoped) and store the credential via §1, or store Nango's `connectionId`.
2. **Initial full sync.** Job lists all events; for each, `map` → `Activity { type: MEETING, title, body, dueAt: start }`; `upsert` keyed via `ExternalLink (connectionId,"event",externalId)`; save `nextSyncToken` (returned only on the **last page**) into `SyncState.watermark`.
3. **Incremental sync.** Every 15 min (or on a Google push webhook), call events.list with `syncToken`; apply added/updated/deleted (deletes → mark `Activity.completedAt`/remove). If Google returns **410 GONE** → clear `SyncState`, trigger full resync.
4. **Write-back (outbound).** When a user creates/edits a `MEETING` Activity in Smart-CRM linked to a connection, `outbound()` POSTs/PATCHes the Google event; store the returned event id in `ExternalLink`; stamp `sourceHash` to prevent the next inbound pull from echoing it back.
5. **Conflict.** If both sides changed since last sync, compare `externalUpdatedAt` vs `Activity.updatedAt` (last-write-wins), and for the rare same-field collision write a `SyncConflict` row.

Why Calendar over Gmail for the reference: smaller object model, clean `nextSyncToken` delta semantics, obvious two-way story (CRM meetings ↔ calendar), and lower privacy surface than full mailbox sync. Gmail (`historyId`, 404→full sync) is the natural second connector.

**(3) Reference evidence.** Google Calendar incremental sync via `nextSyncToken`, last-page-only token, 410 → full resync (https://developers.google.com/workspace/calendar/api/guides/sync). Gmail `historyId` delta + 404 fallback as the follow-on connector (https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list). Nango/Merge can back this same connector if we prefer managed (https://nango.dev/docs/guides/functions/syncs/sync-functions, https://docs.merge.dev/crm/overview/).

**(4) Effort:** **M** (one-way inbound) → **L** (full two-way + conflict UI). Deps: §1–§7.

**(5) Tier:** **Core** (proves the platform).

---

## Top 3 picks

1. **Secure OAuth Token Vault (§1) + Connection Registry (§2)** — *Foundation, Effort S.* Nothing else can exist (native or vendor) until tokens are encrypted at rest (AES-256-GCM, OWASP) and connections are first-class, tenant-scoped objects. Cheapest, highest-leverage, unblocks everything.
2. **Build-vs-Buy substrate decision → adopt Nango, with Merge for CRM-import (§8)** — *Strategic Bet, Effort S to decide.* Choosing the substrate up front avoids hand-rolling OAuth refresh + delta sync per provider; Nango runs syncs off-Vercel (no timeout pain) while we keep our data model. This decision shapes §3–§7's effort.
3. **Incremental sync engine with watermarks + idempotency, behind the Connector interface (§5 + §6), proven by the Google Calendar reference connector (§9)** — *Core, Effort M→L.* This is the actual product: delta pulls (Calendar `nextSyncToken`, 410→full resync), idempotent upserts by external id, last-write-wins conflict handling, and a real end-to-end connector that demonstrates the whole framework.
