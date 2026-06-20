# Smart-CRM — Consolidated Backend & Platform Architecture

**Author:** Backend/Platform Design lead · **Date:** 2026-06-20
**Status:** RESEARCH / DESIGN ONLY — consolidates 20 team design briefs into one architecture report. No repo changes.

This report fuses twenty domain briefs (data model, multitenancy, RBAC, public API, auth/SSO, integrations, webhooks/events, search, notifications, file storage, audit, jobs, email, automation, analytics, caching, realtime, import/export, billing, security/observability) into a single, dependency-ordered plan. The throughline across all twenty: Smart-CRM needs **a small set of shared foundations** — an async job runner, a domain event bus, a custom-fields engine, and an entitlement model — after which most "features" become thin definitions on top. The report opens with the current backend and its constraints, gives a capabilities master table, lays out the foundation-first build sequence and dependency graph, then walks each themed area with the concrete designs (Prisma sketches, library picks) the briefs converged on, and closes with the top 10 prioritized investments.

---

## Current backend (recap)

Grounded in `prisma/schema.prisma` and `src/lib/{tenant,rbac,auth,db}.ts`:

- **Framework:** Next.js 15 (App Router, RSC + **server actions**). All business logic lives in `src/server/actions/*`, each returning a discriminated `ActionResult<T>` (`ok()` / `fail(error, fieldErrors)`), validated with co-located Zod schemas, then `revalidatePath(...)`.
- **Data:** Prisma 5.22 + Postgres 16. `src/lib/db.ts` is a plain global `PrismaClient` singleton — **no pooling config, no `$extends`, no `directUrl`, no query logging hook.**
- **Auth:** NextAuth v5 (beta) with `@auth/prisma-adapter`, **JWT session strategy**, **Credentials provider only** (bcrypt). Edge-safe split config (`auth.config.ts`) vs Node config (`auth.ts`). `Account`/`Session`/`VerificationToken` models exist but are largely unused; `RESEND_API_KEY`/`EMAIL_FROM` declared but unused.
- **Multitenancy:** every domain row carries `orgId`. `requireOrg()` (`src/lib/tenant.ts`) reads `{ userId, orgId, role }` from the JWT; every Prisma query is **manually** filtered `where: { orgId }`. **No Postgres RLS** — isolation is application-enforced only.
- **RBAC:** a 3-tier rank ladder `MEMBER(1) < ADMIN(2) < OWNER(3)` (`src/lib/rbac.ts`, `requireRole`). Notably, **most existing actions never call `requireRole`** — effectively "any member can do anything in the org," including deletes.
- **Deploy:** Vercel **serverless**.

### Key constraints (shape every decision below)

1. **No always-on worker.** Vercel functions are request-scoped/ephemeral; you cannot run a daemon polling a queue or holding `LISTEN`/WebSocket connections. Async work must be **HTTP-invoked** (Inngest/QStash/Cron).
2. **Hard execution ceiling.** ~300s default / 800s max (Fluid). Long jobs (imports, syncs, bulk email) must **chunk across many invocations**.
3. **Connection limits.** Pooled (PgBouncer transaction mode) connection; `connection_limit=1` per lambda recommended. `SET SESSION` is unsafe on a transaction pooler — only `SET LOCAL`/`set_config(..., true)` within a transaction. RLS therefore requires per-tx GUC setting.
4. **4.5 MB request/response body cap** → file uploads and large exports must go browser↔storage directly (presigned/token), not through a function.
5. **Cron cadence** is once-per-day on Hobby, per-minute on Pro; Cron is a *trigger*, not an execution engine.

---

## Capabilities master table

Tiers: **Foundation** (load-bearing; build first) · **Core** (table-stakes feature value) · **Strategic Bet** (high value, heavier, sequence later). Effort: **S** ≈ ≤2 days, **M** ≈ ~1 week, **L** ≈ multi-week.

| Capability | What it unlocks | Recommended approach (lib/service) | Effort | Tier | Depends on |
|---|---|---|---|---|---|
| **Custom-fields engine** (registry + JSONB + dynamic Zod) | No-code typed fields on built-ins, zero-DDL writes | `CustomFieldDefinition` registry + `customFields Json` + compile defs→Zod | M | Foundation | — |
| Custom-field indexing + custom objects | Fast filter/sort on CF; org-defined record types | GIN `jsonb_path_ops` + lazy typed expr indexes; shared `CustomObject`/`CustomRecord` | M / L | Core / Strategic Bet | custom-fields engine |
| Tenant-isolation harness (+ RLS backstop) | Kills "forgot `where:{orgId}`" leak class; DB boundary | Prisma `$extends` auto-inject + `findUnique`→`findFirst`; later RLS via per-tx `set_config` | S–M / L | Foundation / Strategic Bet | — |
| Ownership + OWD, teams, org-switching | Owner/visibility, team roll-ups, validated multi-org | `ownerId`/`visibility`+`defaultRecordVisibility`; `Team`+closure; `switchOrg()` membership check | S / M / S | Foundation / Core | — |
| Territories / sharing rules | Geo/criteria assignment + cross-team sharing | `Territory`/`RecordShare`/`SharingRule` (additive, most-permissive) | L | Strategic Bet | teams |
| **Policy table + compiled ability** (CASL) | Data-driven RBAC; one choke-point closes "any member can delete" | `@casl/ability`+`@casl/prisma` (conditions = `WhereInput`); `authorize()`+`accessibleBy()` | S–M / M | Foundation | — |
| Field-level + custom roles | Hide/freeze fields; per-tenant roles | CASL `fields`; `CustomRole`/`PermissionSet` compiled at request | M–L | Core → Strategic | policy table |
| **Background jobs / queue** (+ observability) | All async work; operable in prod | **Inngest** (durable steps, retries, cron); `JobRun` mirror + DLQ/replay; QStash fallback | M / S–M | Foundation | — |
| **Domain event bus** (transactional outbox + queue) | Webhooks, automation, notifications, analytics | `OutboxEvent` in same tx; drained via `FOR UPDATE SKIP LOCKED` | M / S–M | Foundation | jobs |
| Outbound webhooks (subs + HMAC + retries) | Customer-facing event delivery | `WebhookEndpoint`/`Delivery`/`Attempt`; Standard Webhooks HMAC; backoff; replay | L | Core | events, queue |
| Public REST API `/api/v1` + keys/scopes | Third-party surface; least-privilege programmatic auth | REST (not GraphQL); cursor pagination; hashed `ApiKey` (SHA-256+prefix); `withApiKey` | M / M | Foundation | — |
| API rate limit + idempotency | Safe, fair, retry-safe API | `@upstash/ratelimit` sliding window; `IdempotencyKey` store-and-replay | S–M / M | Core | API keys |
| Social login + email-verify/reset + magic link | One-click sign-in; account trust/recovery; passwordless | NextAuth providers (`Account` ready); Resend + `VerificationToken` | S / S–M | Foundation | — |
| TOTP MFA + session hardening | 2FA; "log out everywhere", device list | `otplib`+`TwoFactor` two-phase; `AuthSession`+`tokenVersion` in `jwt` callback | M / M–L | Core | email verification |
| Enterprise SSO (SAML/OIDC) + SCIM | Sell upmarket; auto-provisioning | **BoxyHQ Jackson** (OSS, native NextAuth provider) / WorkOS; `OrgDomain` binding | L | Strategic Bet | social login |
| Integrations: token vault + connection registry | Encrypted creds; tenant-scoped connections | AES-256-GCM `EncryptedSecret`; `Integration`/`Connection` models | S | Foundation | — |
| Sync engine (watermarks + idempotency) | Two-way provider sync | Connector iface (auth/fetch/map/upsert); `SyncState`/`ExternalLink`; **Nango**/**Merge** substrate | L / S | Core / Strategic Bet | jobs, token vault |
| Full-text search (tsvector + GIN) + typeahead | Relevance-ranked search + instant/typo-tolerant ⌘K | generated `STORED` tsvector + `setweight`; `ts_rank_cd`; `pg_trgm` GIN | M / S–M | Foundation / Core | — |
| Faceted search / dedicated engine | Filters + facet counts; best typeahead at scale | Postgres `GROUP BY` now; **Meilisearch** + tenant tokens later | M / L | Core → Strategic Bet | tsvector / CDC |
| Notifications model + feed + prefs + digests | Notification center; per-type/channel control; reach | `Notification`/`Delivery` (decoupled); `NotificationPreference`; outbox pipeline; tz digests | S / M | Foundation → Core | notif model, events, email |
| Realtime in-app (poll → SSE → Pusher) | Live bell; web push | poll first; VAPID web push Strategic | S–M | Core | notif model |
| File storage adapter + presigned uploads | Attachments of any size, vendor-swappable | Vercel Blob → R2 behind adapter; token/presigned upload (bypass 4.5 MB) | S–M | Foundation | — |
| Polymorphic `Attachment` + signed download + scan/quota | Attach to any record, private; malware/cost safety | `Attachment` (entityType/entityId, provider+key); signed URLs; ClamAV; `SUM(size)` quota | S–M / M | Foundation / Core | storage |
| Audit log spine + capture | Who-did-what-to-what trail | append-only `AuditLog` (JSONB diff) + explicit `recordAudit()`; auth events from NextAuth | S + M | Foundation | — |
| Record history UI + tamper-evidence/retention | Field-history timeline; provable integrity; bounded storage | reuse `AuditLog`; HMAC hash-chain; monthly partitions + BRIN | M / L | Core / Strategic Bet | audit spine |
| Transactional email + provider port | Reliable system email, vendor-swappable | `EmailProvider` iface + Resend; idempotency key; `EmailMessage` | S | Foundation | — |
| Bounce/complaint suppression + tracking | Protect deliverability; open/click events | Svix-verified webhooks (raw body); `Suppression`; `EmailEvent` (idempotent) | M | Foundation → Core | email, jobs |
| Inbound parse + threading; sending domains | Log replies to contact/deal; per-tenant DKIM | Resend Inbound + plus-address/`References`; `SendingDomain` (DKIM/SPF/DMARC) | L | Strategic Bet | queue, email |
| Workflow model + safe conditions | No-code automation definition + safe rules | `Workflow` JSON DAG; **JSON Logic** (`json-logic-engine`) + typed field registry | S + S | Foundation | events |
| Durable workflow execution + guards + actions | Multi-step/delayed/retryable runs; quotas | `WorkflowRun`/`StepRun` memoized replay; loop guards; `ActionHandler`+`PLAN_LIMITS` | L / M | Core → Strategic Bet | jobs, events, conditions |
| `DealStageEvent` history + DB-side aggregation | Funnel/velocity/win-rate (else impossible); fast dashboards | append-only transition log (fix `setDealStatus`); `groupBy`/`$queryRaw` + partial indexes | S / S | Foundation | — |
| Report/dashboard model + spec→SQL engine | Saved report builder (Pipedrive/HubSpot parity) | `Report.spec` JSON (measures/dimensions/filters) + whitelist SQL compiler | M + L | Core | stage events, aggregation |
| Pre-aggregation + warehouse offload | Sub-100ms trends at scale | `DailyDealMetric` summary table via cron; DuckDB/ClickHouse only past trip-wires | M / L | Strategic Bet | stage events |
| Serverless conn mgmt + `directUrl` + slow-query hook | Survive concurrency; safe migrations; perf data | pooled `DATABASE_URL`+`DIRECT_URL`; `$on("query")` slow-query hook | S / S | Foundation | — |
| Cursor pagination + indexes + caching tiers | Constant-time lists; cut DB hits | keyset pagination; composite `(orgId,filter,sort)`; `cache()`→`unstable_cache`→Upstash; `revalidateTag` | M / M | Core | conn mgmt |
| Realtime fan-out transport + OCC | Live Kanban/list sync; stop silent clobbering | managed broker (**Supabase Realtime**/**Pusher**) publish-after-commit; `version` compare-and-swap | M / S–M | Foundation | — |
| Presence + channel authz | "Who's viewing"; no cross-tenant leak | presence channels; `/api/realtime/auth` validates `org:{orgId}:*` | M | Core / Foundation | transport, OCC |
| Import infra + streaming parse + batched upsert | Bulk CSV/XLSX import (the #1 onboarding gap) | Blob upload + chunked job + `ImportJob`; Papa Parse/SheetJS + Zod; partial-unique `ON CONFLICT` | L | Foundation | jobs, storage |
| Dedup + merge + idempotent re-import | Golden records; safe re-runs | exact-key clusters; `MergeLog` survivorship+relink; `externalId` match | M + L | Core | upsert |
| Export all entities + full-account (GDPR) | Round-trippable export; portability | entity-parameterized CSV/XLSX; job→Blob ZIP (JSON+CSV) | M + M | Core | import infra |
| One-click migration (HubSpot/Pipedrive/Zoho) | Switching-cost weapon | per-source mapping presets over the importer; live API later | L | Strategic Bet | import + idempotency |
| Stripe foundation (Checkout + Portal) + webhooks | Self-serve subscribe/manage; Stripe→DB sync | hosted Checkout/Portal; one Customer per org; raw-body `constructEvent` + idempotent | M / M | Foundation | — |
| Plan/Subscription/Entitlement model + gate | The paywall: `requireFeature`/`withinLimit` | `plans.ts` config; `Subscription` mirror; `getEntitlements()` with `requireOrg` | S + M | Foundation → Core | Stripe foundation |
| Seats + metering + dunning/trials | Per-seat billing; usage; retention edges | debounced seat-sync; Stripe Meters v2 + local `UsageCounter`; Smart Retries | M / L / M | Core → Strategic Bet | webhooks, jobs |
| Rate limiting + Sentry + dep/secret scanning | Stop brute-force/scraping; see prod failures; supply-chain | `@upstash/ratelimit`; `@sentry/nextjs` (`sendDefaultPii:false`); Dependabot + secret scanning | S–M / S / S | Foundation | — |
| Structured logging + token encryption + headers/CSP | Queryable logs; protect tokens; XSS/clickjacking defense | `pino`+OTel `x-request-id`; AES-256-GCM `Account.*_token`; `next.config` headers + nonce CSP | M / M / S–M | Core / Foundation | — |
| GDPR tooling + DR + SOC2 program | EU/enterprise deal-blockers | export/erasure/retention jobs; PITR + health checks; control mapping (Drata/Vanta) | M–L / S–M / L | Core → Strategic Bet | audit, jobs, storage |

(~48 consolidated rows from ~180 brief-level capabilities, 1–3 per area; the four bolded foundations recur as dependencies throughout.)

---

## Foundation-first build sequence (dependency graph)

The briefs independently converge on **four foundations**. Build these first; almost everything else is a thin definition on top.

**(a) Background jobs / queue — Inngest.** Serverless-native (runs in Vercel functions over HTTP, no Redis/worker), durable steps, retries, cron, per-key concurrency. *Unlocks:* email send, digests, reminders, rotting-deal scans, webhook delivery, third-party sync, CSV import/export, metering, retention jobs, durable workflow execution.

**(b) Domain event bus via transactional outbox.** Write an `OutboxEvent` in the *same Prisma transaction* as the mutation; a drainer (Inngest/cron) publishes it. One typed event catalog every consumer shares. *Unlocks:* outbound webhooks, workflow automation triggers, notifications, analytics stage events, search index sync, realtime fan-out.

**(c) Custom-fields engine.** `CustomFieldDefinition` registry + JSONB storage + dynamic Zod compilation. *Unlocks:* custom objects, custom-field search, import mapping to user fields, richer reporting dimensions.

**(d) Entitlement / billing model.** `plans.ts` config + `Subscription` mirror + `getEntitlements()` gate composable with `requireOrg()`. *Unlocks:* plan limits across automation/storage/API/seats, paywalled features, monetizable tiers, file quotas.

Two cross-cutting Foundation hardenings ship alongside (cheap, high-leverage, no new infra dependency): **tenant-isolation Prisma extension**, **OCC `version` field**, **`DealStageEvent` history** (irreversible gap — record now or lose it forever), **DB-side aggregation**, and the security trio (**rate limiting + Sentry + dep/secret scanning**).

### ASCII dependency graph

```
                         ┌─────────────────────────────────────────────────────────┐
                         │  CURRENT SPINE: server actions · Prisma · requireOrg ·    │
                         │  RBAC ladder · NextAuth JWT · ActionResult/Zod           │
                         └─────────────────────────────────────────────────────────┘
                                    │
   ┌───────────────┬───────────────┼────────────────┬──────────────────┬───────────────────┐
   ▼               ▼               ▼                ▼                  ▼                   ▼
(a) JOBS       (b) EVENTS      (c) CUSTOM        (d) ENTITLEMENT   ISOLATION harness    SEARCH (tsvector)
  Inngest      outbox+catalog    FIELDS engine     plans+Subscription  (Prisma $extends)   + pg_trgm
   │  │           │  │            │  │                │                   │                   │
   │  │           │  │            │  └─► custom        │                   └─► RLS backstop    └─► facets→Meilisearch
   │  │           │  │            │      objects       │                       (Strategic)
   │  │           │  │            └─► CF search        │
   │  │           │  └──────────────────────┐         │
   │  │           ▼                          ▼         ▼
   │  │      WEBHOOKS (subs+HMAC)      AUTOMATION engine     PLAN LIMITS / paywall gate
   │  │      NOTIFICATIONS pipeline    (triggers→conditions  (automation/storage/API/seats)
   │  │      ANALYTICS stage events     →durable runs)
   │  │      REALTIME fan-out
   │  │
   │  ├─► EMAIL backbone ─► suppression/tracking ─► inbound+threading (Strategic)
   │  ├─► IMPORT/EXPORT (chunked) ─► dedup/merge ─► one-click migration (Strategic)
   │  ├─► INTEGRATIONS sync engine (token vault → connection → watermarks)  [+Nango substrate]
   │  ├─► BILLING seats/metering/dunning  ◄── also needs (d) + Stripe webhooks
   │  └─► REMINDERS · DIGESTS · ROTTING-DEAL scans · RETENTION/DR jobs

INDEPENDENT FOUNDATIONS (no upstream dep, ship in parallel):
   AUTH: social login · email-verify/reset · session hardening · (→SSO/SCIM Strategic)
   AUTHZ: CASL policy table → object-level choke-point → field/custom roles
   PERF: conn-mgmt+directUrl · cursor pagination+indexes · caching tiers · slow-query hook
   TENANCY: ownership+OWD · org-switching · (→teams→territories/sharing)
   STORAGE: provider adapter+presigned upload · Attachment+signed download · (→scan/quota/docs)
   SECURITY: rate limit · Sentry · headers/CSP · dep/secret scan · token encryption
   DATA: OCC version · DealStageEvent · DB-side aggregation
```

Read it as: **everything in the lower/right half is gated by one or more of the four foundations.** Events → webhooks/notifications/automation/analytics/realtime. Jobs → email/sync/imports/sequences/metering/durable-runs. Custom-fields → custom objects/CF-search. Entitlements → all plan gating.

---

## Themed designs

### 1. Data & tenancy

**Custom-fields engine (Foundation).** Decision: **hybrid — JSONB storage + metadata registry + selective typed indexes**, not pure EAV (no kernel to amortize joins; terrible Prisma ergonomics) and not pure JSONB (weak range/sort/typing). JSONB wins on serverless because adding a field is **metadata-only, no `ALTER TABLE`, no migration**.

```prisma
enum CustomEntity { CONTACT COMPANY DEAL }
enum FieldType { TEXT NUMBER CURRENCY DATE DATETIME BOOLEAN SELECT MULTISELECT URL EMAIL PHONE RECORD_REFERENCE }

model CustomFieldDefinition {
  id String @id @default(cuid())
  orgId String
  entity CustomEntity
  key String            // immutable JSON key e.g. "lead_source"
  label String
  type FieldType        // immutable after create (HubSpot rule)
  required Boolean @default(false)
  unique Boolean @default(false)
  filterable Boolean @default(false)   // gates lazy expression-index creation
  sortable Boolean @default(false)
  config Json?          // {options:[...]} | {currency:"USD"} | {refEntity,...}
  archived Boolean @default(false)
  @@unique([orgId, entity, key])
  @@index([orgId, entity])
}
// storage: add `customFields Json @default("{}")` to Contact/Company/Deal
```

A pure function compiles definitions → a Zod schema at request time, producing the **same `fieldErrors` shape** the UI already renders. Indexing: one **GIN `jsonb_path_ops`** per entity for equality/containment; **lazy B-tree expression indexes** (`((customFields->>'arr')::numeric)`) created only when an admin marks a field filterable/sortable — and the app must emit the *exact* cast expression in WHERE/ORDER BY for the planner to use it. Range/sort drops to `$queryRaw` (Prisma JSON filters can't express range on Postgres). Custom objects reuse the whole engine via a shared `CustomObject`+`CustomRecord` table (JSONB-backed, `orgId`+`objectId`-scoped). App-enforced uniqueness via partial unique index `WHERE customFields ? 'key'`. Field "promotion" (JSONB key → real column) is the escape hatch via a chunked, resumable backfill.

**Multitenancy hardening.** The #1 risk is one forgotten `where:{orgId}`. Two layers:
- **Foundation — Prisma client `$extends`** (`query.$allModels.$allOperations`) auto-injects `orgId` into every read/bulk-write for tenant models, stamps it on creates, and **rewrites `findUnique`→`findFirst`** (the sharp edge: `findUnique` ignores extra `where`). Fails closed when no org context. Migration path: add extension, keep manual filters as redundancy, delete table-by-table behind tests.
- **Strategic Bet — Postgres RLS** as the real trust boundary: `USING (orgId = current_setting('app.org_id', true))` with `FORCE ROW LEVEL SECURITY`; GUC set per transaction via `set_config(..., true)` (transaction pooler forbids `SET SESSION`). Index policy columns; wrap volatile calls in `(SELECT …)`; NextAuth adapter queries need a `BYPASSRLS` role.

**Teams, ownership, org-switching, territories.** Add nullable `ownerId` to Contact/Company (Deal/Activity already have it) + `Organization.defaultRecordVisibility` ("ORG"|"TEAM"|"PRIVATE") — Salesforce-style OWD floor that grants widen. `Team`(self-referential `parentId`)+`TeamMembership`, with a **closure table** for O(1) subtree visibility (recursive CTEs per request are costly on serverless). `switchOrg(orgId)` must **verify membership** (currently missing!) and persist `User.lastActiveOrgId`, then re-mint the JWT. Territories (`Territory`/`AccountTerritory`, parallel hierarchy, assignment rules) and cross-team `RecordShare`/`SharingRule` are additive/most-permissive — Strategic Bets gated behind real customer pull.

### 2. AuthZ / AuthN

**Authorization — CASL.** Replace the hardcoded `RANK` ladder with a data-driven policy table compiled into an in-memory ability per request. Use **`@casl/ability` + `@casl/prisma`** because its rule `conditions` *are* Prisma `WhereInput` — so the **same rule both decides a single-record check and filters a list** (no divergence between "can I see X" and "show me all X"; fails closed to an empty result if no grant).

```prisma
enum PermAction { CREATE READ UPDATE DELETE MANAGE }   // MANAGE = wildcard
model Permission     { id String @id @default(cuid())  action PermAction  subject String  @@unique([action, subject]) }
model RolePermission { role Role  permissionId String  @@id([role, permissionId]) }   // built-in roles = seed rows
model CustomRole     { id String @id @default(cuid())  orgId String  name String  @@unique([orgId, name]) }
// Membership gains: customRoleId String?   → ability unions role ∪ customRole ∪ permissionSet grants
```

```ts
// one choke-point every mutation routes through — closes "any MEMBER can delete"
const ability = await buildAbility(ctx);                 // memoized per request, cached per (orgId, roleSig)
if (ability.cannot("DELETE", subject("Deal", deal))) return fail("Forbidden");
// lists reuse the SAME rules: where: { AND: [{ orgId }, accessibleBy(ability).Deal] }
```

Field-level via CASL `fields` (post-query projection for reads, schema narrowing for writes). Record-scope conditions (ownership/visibility/sharing) layer into `buildAbility` as `OR` `WhereInput` fragments. Custom roles/permission sets cached via `packRules`, invalidated on edit. Why not OpenFGA/Oso: relationships are shallow (org→owner→team); Prisma-`WhereInput` gives list-filtering with zero new infra (revisit OpenFGA only if deeply nested team trees emerge). Layer **ownership/visibility** (`recordScope` = `{OR:[{ownerId:userId},{visibility:"ORG"}]}`) before sharing rules; make custom roles the platform headline once the substrate is proven.

**Authentication.** v5 conventions: prefer `AUTH_*` env names; `AUTH_SECRET` both encrypts the JWT and hashes verification tokens; keep Prisma/bcrypt out of Edge middleware (DB-touching auth logic lives in the Node `jwt` callback / route handlers). Activate the dormant pieces:
- **Social login** (Google/Microsoft) — `Account` table is already adapter-shaped, near-zero schema work; decide account-linking policy (`allowDangerousEmailAccountLinking` only for verified-email providers) and a post-sign-in org-onboarding step (first OAuth sign-in has no `Membership`).
- **Email verification + password reset** (Resend + existing `VerificationToken`; always return success on reset request to avoid enumeration; gate access on `emailVerified`); **magic link** via the Resend email provider (shares all plumbing).
- **TOTP MFA** via `otplib` + a `TwoFactor { userId @unique, secret(encrypted), enabled, backupCodes(hashed) }` model and a two-phase login (NextAuth has no native step-up — `authorize` returns a sentinel routing to an OTP screen; stamp `amr:["mfa"]`/`mfaVerifiedAt` in the JWT).
- **Session hardening** (hybrid that keeps JWT + Edge middleware): an `AuthSession { sid @unique, userAgent, ip, revokedAt }` registry + `User.tokenVersion` checked in the Node `jwt` callback enables "log out everywhere", a device list, and forced logout on password reset / role downgrade — bump `tokenVersion` to invalidate globally.

**Enterprise SSO** (Strategic Bet): **BoxyHQ Jackson** (OSS, exposes SAML/OIDC as an OAuth flow, native NextAuth `boxyhq-saml` provider keyed by `tenant`+`product`, no per-connection fee) with email-domain→org binding (`OrgDomain { orgId, domain @unique, verified }`) and JIT provisioning of `User`+`Membership`; **SCIM** directory sync reuses the same vendor (consume its webhooks → upsert membership, map IdP group→`Role`, deactivate→revoke session). WorkOS ($125/connection) is the managed escape hatch.

### 3. Async backbone (jobs + events)

**Jobs — Inngest (Foundation).** The only candidate that runs *inside* Vercel functions over HTTP with durable step execution, retries/backoff (default 4 retries, per-step memoization), cron, and per-key concurrency/throttle — no Redis/worker. Single serve route `src/app/api/inngest/route.ts` (GET/POST/PUT). QStash is the lightweight fallback (pure HTTP fan-out + cron, cheapest); Postgres queues (Graphile/pg-boss) are explicitly **not** viable on pure Vercel (need a long-running poller). Idempotency in three layers: deterministic event/job IDs, idempotent handlers (`ON CONFLICT DO NOTHING` / `sentAt` guards), and the outbox. Mirror runs into a `JobRun` table for in-app observability + DLQ/replay.

**Events — transactional outbox (Foundation).** One typed catalog (`deal.stage_changed`, `contact.created`, …) as a discriminated union + runtime registry; Standard-Webhooks-shaped envelope (ULID `id` = consumer idempotency key). Write the outbox row **in the same `db.$transaction`** as the mutation:

```prisma
model OutboxEvent {
  id String @id @default(cuid())   // == envelope id
  orgId String
  type String                      // "deal.stage_changed"
  payload Json                     // public-safe projection + {previous, changed[]}
  actorUserId String?
  status OutboxStatus @default(PENDING)
  createdAt DateTime @default(now())
  publishedAt DateTime?
  @@index([status, createdAt])     // poller scan (FOR UPDATE SKIP LOCKED)
  @@index([orgId, type, createdAt])
}
```

Drain with `FOR UPDATE SKIP LOCKED` (Postgres-as-queue; concurrent function instances grab disjoint rows). Convert the few bare `db.x.create` actions to wrap write+`emit()` in a transaction; `moveDealToStage`/`setDealStatus` must read the **prior** value in-tx for `from*`/`changed[]`. Start in-Postgres; swap the *driver* to QStash later without changing the event model.

### 4. Comms (email + notifications)

**Email backbone (Foundation).** Thin `EmailProvider` port + Resend adapter (`send`/`sendBatch`) so Postmark/SES are swappable; React Email templates for branded multipart HTML+text.

```prisma
enum EmailDirection { OUTBOUND INBOUND }
enum EmailStatus { QUEUED SENT DELIVERED BOUNCED COMPLAINED FAILED }
model EmailMessage {
  id String @id @default(cuid())
  orgId String  threadId String?  direction EmailDirection @default(OUTBOUND)  status EmailStatus @default(QUEUED)
  providerMessageId String? @unique   // join key for tracking webhooks
  messageId String?  inReplyTo String?  references String? @db.Text   // RFC threading
  contactId String?  dealId String?
  firstOpenedAt DateTime?  openCount Int @default(0)  lastClickedAt DateTime?  clickCount Int @default(0)
  @@index([orgId, status])  @@index([providerMessageId])
}
model EmailEvent  { id String @id @default(cuid())  emailMessageId String  type String  providerEventId String? @unique  occurredAt DateTime }  // idempotent webhook log
model Suppression { id String @id @default(cuid())  orgId String  email String  reason SuppressionReason  @@unique([orgId, email]) }  // per-tenant
```

Every send writes an `EmailMessage` (status + `providerMessageId` join key) and passes an `Idempotency-Key`; suppression checked pre-send. **Bounce/complaint + open/click tracking** via Svix-verified webhooks (**raw body** `req.text()` — parsing breaks the signature), idempotent on `providerEventId`: hard bounce/complaint → immediate `Suppression`, soft → threshold; tracking events append `EmailEvent` (first/max-wins, order-tolerant). **Inbound parsing + threading** (Strategic Bet): Resend Inbound + plus-address token → `In-Reply-To`/`References` → sender match, logged as `EmailMessage(INBOUND)` + `Activity` on the contact/deal. **Per-tenant sending domains** (`SendingDomain` with DKIM strict / SPF relaxed / DMARC) for deliverability. Bulk send is queue-dependent (Resend batch ≤100/call, 2 req/s, fan-out not in-request loop).

**Notifications (Foundation→Core).** Decouple the notification from per-channel delivery:

```prisma
model Notification {
  id String @id @default(cuid())
  orgId String
  recipientId String
  type NotificationType          // MENTION ASSIGNMENT TASK_DUE DEAL_* DIGEST
  entityType String?  entityId String?
  title String  body String? @db.Text  data Json?  groupKey String?
  seenAt DateTime?  readAt DateTime?  archivedAt DateTime?
  createdAt DateTime @default(now())
  @@index([orgId, recipientId, createdAt])
  @@index([recipientId, readAt])
}
// + NotificationDelivery(channel, status, scheduledFor) per channel attempt
```

Per-user `NotificationPreference` (per type × channel) + `NotificationSettings` (timezone, quiet hours, digest). Generation rides the **same outbox pipeline**: resolve recipients → apply prefs + dedup (`@@unique(dedupeKey)`) + rate-limit → create `Notification` + deliveries → dispatch. Digests via tz-aware cron sweep over `DIGESTED` deliveries. Build in-house for Foundation+Core; the dispatch step is an adapter so a later Knock/Novu buy is a contained switch. Web push (VAPID) is a Strategic Bet (low marginal value in B2B).

### 5. Extensibility (public API + webhooks + integrations)

**Public API — REST `/api/v1` (Foundation).** REST over GraphQL: lower adoption barrier, webhooks are REST-shaped, GET caching/per-route rate limiting, and 1:1 mapping onto existing server actions (Stripe/HubSpot/Pipedrive are all REST). **Hashed API keys + scopes**: `sk_live_<random>` shown once; store `lookupPrefix` (indexed O(1)) + `keyHash = SHA-256(plaintext)`; verify with timing-safe compare; scopes (`contacts.read`…) give the least-privilege the current actions lack. Cursor pagination (opaque `{id,createdAt}`, `has_more`/`next_cursor`), allowlisted filters (`updatedAt[gte]` is the incremental-sync primitive), consistent error envelope mapping `fail()`/thrown errors to Stripe-shaped `{type,code,message,field_errors}`. **Rate limit** (`@upstash/ratelimit` sliding window keyed by API key) + **idempotency** (`IdempotencyKey` store-and-replay, `INSERT … ON CONFLICT`). OpenAPI generated from the Zod schemas. OAuth2 + first-party SDK are Strategic Bets.

**Outbound webhooks (Core).** Two at-least-once reliability boundaries (mutation→event via outbox; event→endpoint via delivery queue), so consumers must be idempotent — we ship a stable `webhook-id` for dedup.

```prisma
model WebhookEndpoint {
  id String @id @default(cuid())
  orgId String  url String           // https only, SSRF-guarded (block private/loopback/metadata IPs)
  enabledEvents String[]             // ["deal.*","contact.created"]; "*" = all
  secret String                      // "whsec_<base64>" for HMAC
  status EndpointStatus @default(ENABLED)   // auto-DISABLED after sustained failure
  @@index([orgId])
}
model WebhookDelivery {
  id String @id @default(cuid())
  endpointId String  orgId String  eventId String  payload Json   // frozen envelope (replay-faithful)
  status DeliveryStatus @default(PENDING)   // PENDING DELIVERING SUCCEEDED FAILED DEAD
  attempts Int @default(0)  nextAttemptAt DateTime @default(now())  lockedAt DateTime?
  @@index([status, nextAttemptAt])   // SKIP LOCKED claim query
}
// + WebhookDeliveryAttempt(attemptNo, responseCode, responseMs, responseBody truncated) for the logs UI
```

Fan-out from the outbox → insert `WebhookDelivery` per matching enabled endpoint → claim due rows with `FOR UPDATE SKIP LOCKED` → signed POST. **Standard Webhooks HMAC** (`webhook-id`/`webhook-timestamp`/`webhook-signature`; signed content `${id}.${ts}.${rawBody}`; `v1,<base64(HMAC_SHA256)>`; 5-min replay tolerance). Svix-style backoff (immediate, 5s, 5m, 30m, 2h, 5h, 10h, 10h) → `DEAD`; auto-disable endpoints after sustained failure + emit `webhook.endpoint.disabled`. Customer-facing replay clones the frozen payload into a new delivery with the **same `eventId`** (idempotent receivers dedup). Driver: Vercel Cron for v1, QStash when latency/scale matters.

**Integrations framework.** **Buy the substrate, build the mapping** — hand-rolling N OAuth flows + refresh + delta-sync is the expensive, low-differentiation part. Foundation pieces (needed even for one native connector), distinct from the NextAuth `Account` table:

```prisma
model EncryptedSecret { id String @id @default(cuid())  keyId String  iv Bytes  authTag Bytes  ciphertext Bytes }  // AES-256-GCM envelope
model Connection {
  id String @id @default(cuid())
  orgId String  integrationId String   // tenant scope — always filter
  status ConnectionStatus @default(PENDING)  direction SyncDirection @default(INBOUND)
  externalAccountId String?  vendorConnectionId String?   // Nango/Merge id when managed
  secretId String? @unique  expiresAt DateTime?           // -> EncryptedSecret for native refresh
  @@unique([orgId, integrationId, externalAccountId])  @@index([orgId, status])
}
model SyncState    { id String @id @default(cuid())  connectionId String  object String  watermark String?  cursor String?  @@unique([connectionId, object]) }
model ExternalLink { id String @id @default(cuid())  orgId String  connectionId String  object String  externalId String  localId String  sourceHash String  @@unique([connectionId, object, externalId]) }
```

Native OAuth refresh uses single-flight via `pg_advisory_xact_lock` to avoid refresh stampedes. Sync engine: a `Connector` interface (`auth`/`fetch`/`map`/`upsert`, `outbound` for two-way); read watermark → fetch deltas → upsert keyed on external id (last-write-wins) → advance watermark only after the page commits; `sourceHash` stops echo loops in bidirectional sync. Substrate decision (Strategic Bet): **Nango** as default (managed OAuth + refresh + syncs run off-Vercel, we keep our model), **Merge.dev** for the bulk "import my existing CRM" job, native escape hatch for strategic connectors. Reference connector: Google Calendar two-way (`nextSyncToken`, 410→full resync; Gmail `historyId`, 404→full sync as the follow-on).

### 6. Search

Replace `ILIKE '%q%'` (sequential scan, no ranking, no typo tolerance). **Phase 1 (Foundation, native Postgres — `pg_search`/BM25 is no longer available on new Neon projects):** generated **`STORED` tsvector** columns per entity, `setweight`-tagged (`'simple'` for names/emails, `'english'` for prose), GIN-indexed — stay in sync automatically, no triggers/CDC. Query with `websearch_to_tsquery` (never throws on user input) + `ts_rank_cd` (cover-density), `orgId` bound first. **Phase 1.5 (Core):** `pg_trgm` GIN on high-signal short fields for as-you-type prefix + typo fallback (`similarity > 0.3`); hybrid FTS-then-trigram merge. **Facets** are `GROUP BY` over existing composite indexes. **Phase 2 (Strategic Bet):** **Meilisearch** denormalized index (best typeahead/facet-distribution) synced via **CDC or trigger→outbox** (never app-side dual writes), with **tenant tokens** (JWT embedding an `orgId` `searchRules` filter — cryptographically enforced isolation). Custom-field search folds JSONB text into the tsvector once the engine lands.

### 7. Storage

**Provider adapter (Foundation):** `src/lib/storage/` interface (`createUploadToken`/`getSignedDownloadUrl`/`deleteObject`/`headObject`); store `provider`+`key`, never a provider URL. Start on **Vercel Blob** (native `handleUpload`, no IAM/CORS), plan migration to **Cloudflare R2** (zero egress, $0.015/GB) — a config swap. **Presigned/token client uploads** bypass the 4.5 MB body cap: browser→storage directly; the function only mints a scoped token (`allowedContentTypes`/`maximumSizeInBytes`/embedded `{orgId, attachmentId}`) and, on confirm, `headObject`s the **true** byte size — never trust client-reported size.

```prisma
enum AttachmentEntity { CONTACT COMPANY DEAL ACTIVITY EMAIL ORGANIZATION }
enum AttachmentStatus { PENDING SCANNING READY INFECTED FAILED }
model Attachment {
  id String @id @default(cuid())
  orgId String
  entityType AttachmentEntity  entityId String   // polymorphic; no DB FK → app-enforced existence + orgId
  provider StorageProvider @default(VERCEL_BLOB)  key String   // object key = source of truth, not a URL
  filename String  contentType String  size Int  checksum String?
  status AttachmentStatus @default(PENDING)  thumbnailKey String?
  uploadedById String?
  @@index([orgId, entityType, entityId])   // list attachments for a record
  @@index([orgId, status])                  // quota SUM / scan sweeps
}
```

Private by default; **short-lived signed download URLs** (`expiresIn: 60`) gated by `requireOrg()` + `findFirst({id, orgId})`; reject unless `status===READY`; key namespace `org/{orgId}/...`; `Content-Disposition: attachment` (mitigates inline-HTML/SVG XSS). **Virus scan** (ClamAV-on-object-event for S3/R2, scan API for Blob; quarantine on infected, bucket versioning to prevent swap) + per-org `SUM(size)` quota enforced at token time (forces the first `Plan`/quota primitive; storage-layer size cap via presigned conditions so the client can't lie). Type allowlist rejects SVG/HTML. Docs/templates/e-sign layer on top (Strategic Bet).

### 8. Automation engine

Depends on events (a) + jobs (a). **Definition:** `Workflow` storing `trigger`/`conditions`/`definition` as JSON (a DAG, versioned atomically; pin `workflowVersion` per run so editing a live workflow can't corrupt in-flight runs). **Safe conditions:** **JSON Logic** (`json-logic-engine` — faster, deterministic, safe for untrusted rules) gated by a **typed per-entity field registry** (reject unknown vars/type-mismatched ops; this is the real safety layer, making it a typed AST in practice). **Durable execution (the core):** the Inngest/Trigger.dev model — advance one step per short invocation, persist after each step:

```prisma
model WorkflowRun {
  id String @id @default(cuid())
  orgId String  workflowId String  workflowVersion Int
  status RunStatus @default(QUEUED)   // QUEUED RUNNING WAITING SUCCEEDED FAILED CANCELLED
  dedupeKey String @unique            // enrollment idempotency
  cursor Int @default(0)  wakeAt DateTime?  stepsExecuted Int @default(0)
  @@index([status, wakeAt])           // cron picks up due WAITING runs
}
model StepRun {
  id String @id @default(cuid())
  runId String  stepId String  status StepStatus @default(PENDING)
  attempt Int @default(0)  output Json?         // memoized for replay
  @@unique([runId, stepId])
}
```

Memoized replay (skip+reuse `SUCCEEDED` steps), per-step retry with backoff, `wait` → `WAITING`+`wakeAt` (sleeping runs cost no compute), idempotency end-to-end (enrollment dedupe + step `@@unique` + external side-effect keys). **Action framework:** discriminated-union `Step` + `ActionHandler` registry (update_field, create_activity, add_tag, send_email, webhook, wait, branch); reuse existing actions; `update_field` constrained to the field registry. **Guards** (loop ceiling `maxStepsPerRun`, cascade `causationDepth`, re-enrollment ONCE/ALWAYS/EVERY_N_HOURS) and **plan limits** (`PLAN_LIMITS` checked at save + enqueue) prevent runaway storms. Execution log + dry-run is a Strategic Bet.

### 9. Analytics backend

The irreversible gap: stage transitions are overwritten today (`moveDealToStage` does a bare `update`; `setDealStatus` uses `updateMany` with no before-read), so funnel/velocity/win-rate-trend are **impossible retroactively**. The Foundation — record now:

```prisma
model DealStageEvent {
  id String @id @default(cuid())
  orgId String  dealId String
  fromStageId String?  toStageId String?  fromStatus DealStatus?  toStatus DealStatus?
  valueAt Decimal @db.Decimal(12,2)   // deal-value snapshot at transition
  actorId String?  changedAt DateTime @default(now())
  @@index([orgId, changedAt])  @@index([dealId, changedAt])  @@index([orgId, toStageId, changedAt])
}
```

**Fix `setDealStatus`** to read before-state; wrap read+update+event in a `$transaction`; `createDeal` emits a seed event; denormalize `Deal.stageEnteredAt` for cheap "current time-in-stage". **DB-side aggregation (Foundation):** replace the dashboard's `findMany`+JS `reduce` (loads every deal row) with `groupBy`/`$queryRaw` using `FILTER`/`GROUPING SETS` + partial indexes (`WHERE status='OPEN'`). **Report model (Core):** `Report.spec` JSON (`{measures, dimensions, filters}` — the Pipedrive/HubSpot shared primitive) + `Dashboard`/`DashboardCard`; a **spec→SQL engine** compiles it with a per-source field **whitelist** (bound `orgId` param, never interpolate identifiers). Funnel (window `LAG`/`LEAD` over stage counts) and velocity (`LEAD()` interval pairing) derive from `DealStageEvent`. Forecast = `SUM(value × stage_probability)`; `Goal` model for target-vs-actual. **Pre-aggregation** (`DailyDealMetric` summary table refreshed by cron — preferred over matviews which only do full `REFRESH`) and warehouse offload (DuckDB→ClickHouse) are Strategic Bets gated behind explicit trip-wires (tens of millions of rows / p95 > 1s). Enable RLS as defense-in-depth for analytics queries; per-tenant cache keys.

### 10. Performance & caching

**Foundation:** serverless connection management — pooled `DATABASE_URL` (`?pgbouncer=true&connection_limit=1&pool_timeout=20`) + add **`directUrl = env("DIRECT_URL")`** to the datasource (currently absent; migrations otherwise run through the pooler). Slow-query observability: switch `db.ts` to event logging + `$on("query")` slow-query hook (keep it on the base client — extensions can disable `$on`). **Core:** cursor/keyset pagination (replaces silent `take:200` and unbounded `findMany`; always tiebreak on `id`); composite indexes matching `where`+`orderBy` together (`Deal [orgId,status,createdAt]`, `Contact [orgId,lastName,firstName]`, `Activity [orgId,completedAt,dueAt,createdAt]`); `select` discipline over blanket `include` (drop `notes @db.Text`); push dashboard aggregation into Postgres. Caching tiers: React `cache()` (per-request dedupe) → `unstable_cache` with org-scoped tags (`org:<id>:stages`) → Upstash (cross-request: rate limits, hot reads); org/entity-keyed `revalidateTag` invalidation replacing broad `revalidatePath` (requires lifting blanket `force-dynamic`).

### 11. Realtime

Self-hosted WebSockets/SSE are non-viable (request-scoped functions, ~800s ceiling). **Architecture: a managed broker the browser connects to directly; server actions publish thin deltas via REST after the Prisma commit** — server stays the single writer/authority. **Transport (Foundation):** **Supabase Realtime Broadcast** (keeps Prisma + our Postgres, RLS-based channel auth, likely $0 if already on Supabase) or **Pusher** (cleanest presence). **OCC (Foundation, no vendor):** add `version Int`; switch deal writes to `updateMany` compare-and-swap (`where:{id,orgId,version}`, `count===0`⇒conflict) — stops silent clobbering *and* makes delta ordering safe (clients drop stale `version`s). **Live Kanban/list/record sync (Core):** publish `{type, id, version}` after writes with `socket_id` self-exclusion; clients reconcile into the existing `setDeals` reducer. **Presence + channel authz (Foundation):** `/api/realtime/auth` calls `requireOrg()` and validates the channel starts with `org:{orgId}:` — without this, realtime is a tenant-isolation hole. Typing indicators + durable realtime notifications are Strategic Bets.

### 12. Import / export / migration

The #1 onboarding blocker: no importer exists. **Foundation triplet:**

```prisma
enum ImportStatus  { UPLOADED MAPPING VALIDATING RUNNING PARTIAL DONE FAILED CANCELLED }
enum ImportDupMode { CREATE_ONLY UPDATE_ONLY UPSERT SKIP_DUPLICATES }
model ImportJob {
  id String @id @default(cuid())
  orgId String  createdById String  entity ImportEntity  status ImportStatus @default(UPLOADED)
  source String @default("CSV")  blobUrl String  mapping Json?   // {csvHeader -> {field, transform?}}
  matchKeys String[] @default([])  dupMode ImportDupMode @default(UPSERT)
  totalRows Int @default(0)  processed Int @default(0)  created Int @default(0)  updated Int @default(0)  failed Int @default(0)
  @@index([orgId, status])
}
// + ImportRowError(rowNumber, code, message, raw Json) — only error rows persisted, for fix-and-reimport
```

(1) infra — client upload to **Vercel Blob** (bypass 4.5 MB) + chunked Inngest job (process ~500-row batches across invocations; partial success, not abort-on-bad-row; `ImportJob` status drives a progress poller). (2) streaming parse (**Papa Parse**/SheetJS, format-agnostic row stream) + auto-map UI + per-entity Zod. (3) batched upsert with **partial unique indexes** (`CREATE UNIQUE INDEX … WHERE email IS NOT NULL` — raw migration since email/domain are nullable) → `createMany skipDuplicates` (`ON CONFLICT DO NOTHING`) or raw `INSERT … ON CONFLICT (orgId,email) DO UPDATE` (Prisma `$transaction` can't batch `upsert`). **Core:** duplicate detection (exact-key `GROUP BY lower(email/domain)` clusters), record **merge** (`MergeLog` survivorship + transactional child relink — relink **must precede** delete since FKs are `SetNull`; `snapshot` enables undo, beating Zoho's irreversible merge), idempotent re-import via `externalId`, generalized CSV/XLSX export (round-trip headers + leading `externalId`), full-account GDPR export (job→Blob ZIP, JSON graph + CSV per entity). **One-click migration** from HubSpot/Pipedrive/Zoho (per-source mapping presets over the importer, dependency-ordered Companies→Contacts→Deals→Activities; live API connectors later) is the Strategic Bet switching-cost weapon.

### 13. Billing

Keyed to **Organization** (the billable entity), not User. **Foundation:** hosted **Stripe Checkout** (acquisition) + **Billing Portal** (management) — zero PCI/SCA/tax/invoice UI; one Customer per org (`stripeCustomerId`, `client_reference_id=orgId`).

```prisma
enum SubStatus { TRIALING ACTIVE PAST_DUE CANCELED UNPAID INCOMPLETE INCOMPLETE_EXPIRED PAUSED }
model Subscription {
  id String @id @default(cuid())
  orgId String @unique
  stripeSubscriptionId String? @unique  stripePriceId String?  planKey String @default("free")
  status SubStatus @default(TRIALING)  seats Int @default(1)
  currentPeriodEnd DateTime?  cancelAtPeriodEnd Boolean @default(false)  trialEndsAt DateTime?
}
model Entitlement { id String @id @default(cuid())  orgId String  key String  intValue Int?  boolValue Boolean?  @@unique([orgId, key]) }  // per-org overrides only
```

`Subscription` mirrors local Stripe state so gates make **no Stripe call per request** (active when `currentPeriodEnd + 1-day grace > now`); `plans.ts` is config-as-code (`{stripePriceId, limits, features}`); `Entitlement` rows are escape-hatch overrides (sales comps). **Webhooks (Foundation — what makes it true):** raw-body `constructEvent` signature verify, idempotent via `ProcessedWebhookEvent`, map `customer.subscription.*`/`invoice.*` → `status`/`planKey`/`seats`. **Gate (Core):** `getEntitlements(orgId)` + `requireFeature`/`withinLimit` composed after `requireOrg()`; `fail("upgrade_required")` → generic paywall CTA (features fail closed, limits fail open on infra error). **Seats** synced to `Membership` count via a **debounced** job (Stripe rate-limits frequent quantity updates). **Metering** (Strategic Bet): Stripe Meters v2 for billing + a separate synchronous local `UsageCounter` for hard caps (Stripe data lags). Trials/dunning lean on Stripe-native Smart Retries; our code is the in-app `PAST_DUE` banner.

### 14. Security / compliance / observability

**Foundation (acute + cheap):** **rate limiting** (`@upstash/ratelimit` — auth `slidingWindow(5,"15m")` keyed by IP+email; the unthrottled `bcrypt.compare` in `authorize()` is a live DoS/brute-force vector; public lead-capture is highest-abuse); **Sentry** (`@sentry/nextjs` wizard — `instrumentation.ts`/`onRequestError`/`global-error.tsx`; `tracesSampleRate~0.1`; **`sendDefaultPii:false`** + `beforeSend` scrubbing of email/phone/tokens/notes); **static security headers + nonce CSP** (start report-only) + tighten `images.remotePatterns` off `**`; **Dependabot + secret scanning + push protection + `pnpm audit`** in CI. **Core:** structured logging (`pino` + OTel, `x-request-id` correlation), the **`AuditLog` spine**, and **token encryption**.

```prisma
model AuditLog {
  id String @id @default(cuid())
  orgId String?      // nullable: LOGIN_FAILURE precedes org resolution
  actorId String?  actorEmail String?   // denormalized → survives user deletion (GDPR-safe label)
  action AuditAction  entity String  entityId String?
  summary String?  diff Json?  metadata Json?   // {ip, ua, requestId, source}
  createdAt DateTime @default(now())
  seq BigInt?  prevHash String?  hash String?    // nullable now → hash-chain ships later (Strategic)
  @@index([orgId, entity, entityId, createdAt])   // per-record timeline
  @@index([orgId, action, createdAt])             // security-event filtering
}
```

Capture via explicit `recordAudit(tx, …)` in actions — **chosen over Postgres triggers / implicit Prisma `$extends`** because the pooled connection sees only `app_user` (not the human), and the count-only `updateMany`/`deleteMany`/`$transaction` paths defeat generic auto-capture (the action already does the pre-read for the before-image). Diff is a `{field:{old,new}}` JSONB map with a secret denylist. Security/auth events (login success/failure, role/membership changes, exports) reuse the same table from NextAuth `events`. **Token encryption**: AES-256-GCM (`{iv, ciphertext, tag, keyId}`) for `Account.refresh_token/access_token/id_token`; **don't** encrypt searchable PII — it breaks `@@index([orgId,email])`/filtering (rely on managed at-rest + access control + log redaction instead). **Strategic Bets:** hash-chain tamper-evidence + partitioned retention, GDPR erasure/retention jobs + DPA, and the umbrella **SOC 2 program** (MFA, access reviews, DR drills, control mapping via Drata/Vanta). Health checks (`/api/health`) + document PITR (RPO≤min/RTO≤1h) are Foundation.

---

## Top 10 backend investments (prioritized, foundation-first)

1. **Background jobs / queue — Inngest.** *(Foundation)* The serverless-native async backbone (durable steps, retries, cron, concurrency) that unblocks email, sync, imports, sequences, metering, retention, and durable workflow execution. Nothing async is reliable without it.
2. **Domain event bus via transactional outbox.** *(Foundation)* Atomic "mutation + event" on the existing Postgres/`$transaction`; the one seam every other team (webhooks, automation, notifications, analytics, realtime) subscribes to.
3. **Tenant-isolation Prisma extension + OCC `version` + RBAC choke-point.** *(Foundation)* Three cheap correctness fixes for live gaps: kills the "forgot `where:{orgId}`" leak class, stops silent last-write-wins, and closes "any MEMBER can delete." No new infra.
4. **Custom-fields engine (registry + JSONB + dynamic Zod).** *(Foundation)* The extensibility substrate — zero-DDL custom fields on built-ins, reused for custom objects, CF-search, and import mapping; viable on serverless precisely because writes need no migration.
5. **Entitlement/billing model + Stripe webhooks.** *(Foundation)* Org-keyed `Subscription` mirror + `requireFeature`/`withinLimit` gate composed with `requireOrg()`, made true by idempotent signed webhooks — the paywall every feature enforces against.
6. **`DealStageEvent` history + DB-side aggregation.** *(Foundation)* Record stage transitions now (irreversible if deferred) and move dashboard math into Postgres `groupBy` — unblocks funnel/velocity/win-rate-trend and stops streaming every deal row to Node.
7. **Security trio: rate limiting + Sentry + dep/secret scanning.** *(Foundation)* Closes the most acute live risk (unthrottled `bcrypt` login), ends production blindness, and catches supply-chain leaks — all low effort, immediate SOC 2 evidence.
8. **Public REST API `/api/v1` + hashed API keys/scopes + rate limit/idempotency.** *(Foundation/Core)* The programmatic surface for integrations and the dependent webhooks roadmap, reusing the `requireOrg()` `{orgId}` contract and finally adding least-privilege.
9. **Import infrastructure (Blob + chunked job + streaming parse + dedup-upsert).** *(Foundation)* Removes the #1 onboarding blocker (no import at all) and is the base for merge, GDPR export, and one-click competitor migration.
10. **Outbound webhooks + email backbone + notifications pipeline.** *(Core)* The first high-value consumers of the event/jobs foundations: signed/retried webhooks (the platform surface), Resend transactional email with suppression, and the decoupled notification center — each a thin layer once (1)+(2) exist.

*Sequencing note:* foundations (1–7) are largely parallelizable across the team and unblock the rest; tenancy/RBAC/perf/storage/auth hardenings ride alongside as independent Foundation wins. Strategic Bets (RLS, SSO/SCIM, custom objects, Meilisearch, territories/sharing, metering, inbound email, warehouse, SOC 2) are gated behind the foundations and a real customer pull.
