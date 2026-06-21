# Smart-CRM — Public API Design Brief

**Author:** Senior Backend/Platform Engineer
**Date:** 2026-06-20
**Scope:** Design a developer-facing public API exposing the CRM (contacts, companies, deals, activities, pipeline stages, tags) for third-party integrations and the (other-team) webhooks/integrations roadmap.
**Status:** RESEARCH/DESIGN ONLY — no repo changes proposed here are implemented.

---

## Context: where Smart-CRM is today

Read of the current codebase (`src/server/actions/*`, `src/lib/tenant.ts`, `src/lib/rbac.ts`, `src/app/api/*`, `prisma/schema.prisma`):

- **All business logic lives in Next.js server actions** (`createContact`, `updateDeal`, etc.), each returning a discriminated `ActionResult<T>` (`{ ok: true, data } | { ok: false, error, fieldErrors }` — `src/lib/action-result.ts`). These are *not* HTTP-callable by external clients.
- **Tenant scoping** is enforced exclusively via `requireOrg()` (`src/lib/tenant.ts`), which reads `session.user.activeOrgId` + `role` from the NextAuth JWT. Every Prisma query is manually filtered by `orgId` (e.g. `db.contact.findFirst({ where: { id, orgId } })`). There is **no DB-level RLS** — isolation is application-enforced, so the public API must re-apply the exact same discipline.
- **RBAC** is a 3-tier rank ladder: `MEMBER(1) < ADMIN(2) < OWNER(3)` (`src/lib/rbac.ts`, `requireRole`). Note: the existing CRM actions do **not** call `requireRole` — any member can mutate. The public API is the right place to introduce least-privilege via **scopes** (decoupled from human roles).
- **Zod schemas are co-located and NOT exported** (e.g. `contactSchema` inside `contacts.ts`). They are also UI-shaped (`.optional().or(z.literal(""))` to accept empty form strings, `z.coerce.number()` for form values). Reusing them verbatim for JSON would leak form quirks (empty-string-as-null) into the API contract — they need light refactoring into shared, API-friendly schemas.
- **The only non-auth route handler today** is the CSV export at `src/app/(app)/contacts/export/route.ts`. It is the proof-of-pattern: a route handler that calls `requireOrg()`, returns `401` on failure, and streams a response. The public API generalizes this — but authenticated by **API key**, not session cookie.
- **Data model facts that shape the API:** cuid string IDs; `createdAt`/`updatedAt` on Company/Contact/Deal/Activity (good cursor candidates); `Deal.value` is `Decimal(12,2)` (must serialize as string to avoid float loss); enums `DealStatus`, `ActivityType`, `Role`; tenant = `Organization` (`orgId`). No `env` validation module exists yet (`src/lib/env.ts` absent).
- **Runtime:** Vercel serverless (Node), Prisma + Postgres, NextAuth v5 JWT sessions. Serverless => no in-process shared state for rate limiting; need an external store.

**Headline recommendation: REST, versioned under `/api/v1/*`, authenticated by hashed API keys with scopes, cursor-paginated, with an Upstash-Redis rate limiter and idempotency keys on writes.** GraphQL is explicitly *not* recommended for v1 (justification in §1).

---

## 1. REST vs GraphQL — recommend **REST** (`/api/v1`)

**(1) What it enables.** A predictable, cacheable, low-barrier HTTP surface that external developers and other internal teams (webhooks) can consume with `curl` and any HTTP client, no special tooling.

**(2) Design / decision.**
- **Choose REST**, resource-oriented, JSON, base path `/api/v1`. Resources mirror the domain: `/contacts`, `/companies`, `/deals`, `/activities`, `/pipeline-stages`, `/tags`.
- Standard verb mapping: `GET` (list/retrieve), `POST` (create), `PATCH` (partial update — matches the "update only provided fields" need better than the current full-object `update`), `DELETE`.
- **Why not GraphQL for v1:**
  1. **Adoption barrier.** "Developers are simply more likely to adopt your API if it's built using REST" — GraphQL introduces an entry barrier for third-party integrators. [DEV — REST vs GraphQL]
  2. **Webhooks are REST-shaped.** The dependent webhooks/integrations roadmap is inherently REST: "If you need to receive webhooks, you need REST endpoints with no way around it." [DEV — REST vs GraphQL] A consistent REST surface keeps the platform coherent.
  3. **Caching & rate limiting.** `GET /contacts/{id}` is cacheable by CDNs/clients and trivially rate-limited per-route; GraphQL is `POST /graphql`, which "CDNs don't cache by default" and needs query-cost analysis to rate-limit safely. [DEV — REST vs GraphQL]
  4. **Maps 1:1 onto existing server actions + Prisma.** Each resource handler is a thin shell over the logic already in `src/server/actions/*`. GraphQL would need resolvers, dataloaders (N+1), and depth/complexity limiting — large net-new surface for a team that has *no* API today.
  5. The industry pattern is exactly this split: "REST for public-facing third-party integrations and webhooks where universality and caching matter." [DEV — REST vs GraphQL] All three benchmarks (Stripe, HubSpot CRM v3, Pipedrive) are REST. [Stripe API Ref][HubSpot][Pipedrive]
- **Field selection without GraphQL:** support a `fields=` sparse-fieldset param and `expand=company,owner` (Stripe-style expandable objects) to satisfy the main GraphQL draw (over-fetching) cheaply.
- Revisit GraphQL only as a Strategic Bet if a partner ecosystem demands it post-v1.

**(3) Reference evidence.** Hybrid guidance "GraphQL for primary app API… REST for public-facing third-party integrations and webhooks"; webhooks "need REST endpoints, no way around it"; caching advantage of REST GETs over GraphQL POSTs — [REST vs GraphQL, DEV Community](https://dev.to/chizihn/rest-vs-graphql-why-i-use-both-and-you-probably-should-too-28a0) and [REST vs GraphQL real-world guide, DEV](https://dev.to/rosewabere/rest-vs-graphql-vs-websockets-vs-webhooks-a-real-world-decision-guide-with-code-2bem). Benchmarks are REST: [Stripe API Reference](https://docs.stripe.com/api), [HubSpot CRM API guide](https://trio.dev/hubspot-api/), [Pipedrive API concepts](https://pipedrive.readme.io/docs/core-api-concepts-pagination).

**(4) Effort: M.** Deps: routing/handler scaffolding under `src/app/api/v1/*`; shared response/error helpers; refactor of Zod schemas (§9).

**(5) Tier: Foundation.** Everything else hangs off this choice.

---

## 2. Authentication — hashed **API keys + scopes** (v1), OAuth2 later

**(1) What it enables.** Programmatic, per-tenant access for server-to-server integrations and internal teams, with least-privilege scopes and revocability — without sharing user passwords or cookies.

**(2) Design.**

**Key format (Stripe/HubSpot-style, secret-scanner friendly):**
- Plaintext shown **once** at creation: `sk_live_<24+ random bytes base62>` (and `sk_test_` for a future sandbox). The `sk_live_` prefix lets GitHub/secret-scanners detect leaks and makes keys self-identifying. [Zuplo][Bomberbot]
- Store a separate **short, indexed lookup prefix** (first ~8 chars after the env segment, e.g. `sk_live_a1b2c3d4`) to find the candidate row in O(1), then verify the full hash. Hashing alone isn't searchable; the prefix index is the standard fix. [API key best practices]

**Hashing:** never store the plaintext. Store `keyHash = SHA-256(plaintext)` (fast, deterministic, indexable — these are high-entropy random secrets, so a slow KDF like bcrypt is unnecessary and harmful on a hot path; SHA-256 is the recommended choice for API keys). [Zuplo / OneUptime] Look up by `lookupPrefix`, then constant-time compare the SHA-256. "Even if your database is compromised, the attacker cannot use the hashes to make API calls." [Zuplo]

**Scopes (decoupled from human Role):** space-delimited, resource:action shaped, HubSpot-style (`crm.objects.contacts.read`). Smart-CRM set, e.g.:
`contacts.read contacts.write companies.read companies.write deals.read deals.write activities.read activities.write tags.read pipeline.read`. A key grants a subset; handlers assert the scope before touching data. This finally introduces least-privilege the current server actions lack. [HubSpot scopes]

**Prisma model sketch** (new models — design only):
```prisma
model ApiKey {
  id           String    @id @default(cuid())
  orgId        String                          // tenant binding — every request is pre-scoped to this org
  name         String                          // human label, e.g. "Zapier prod"
  lookupPrefix String    @unique               // indexed fast path, e.g. "sk_live_a1b2c3d4"
  keyHash      String    @unique               // SHA-256(plaintext), never the plaintext
  scopes       String[]                        // ["contacts.read", "deals.write", ...]
  createdById  String                          // user who minted it
  lastUsedAt   DateTime?                        // soft usage signal (best-effort, throttled write)
  expiresAt    DateTime?                        // optional rotation/expiry
  revokedAt    DateTime?                        // soft-delete => instant revoke
  createdAt    DateTime  @default(now())

  org          Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId])
  @@index([lookupPrefix])
}
```

**Request path (new helper, the API analogue of `requireOrg()`):**
```
Authorization: Bearer sk_live_...        // (also accept x-api-key)
-> parse env + lookupPrefix
-> ApiKey.findUnique({ where: { lookupPrefix } })
-> if !row || row.revokedAt || (expiresAt && past)  -> 401
-> timingSafeEqual(sha256(presented), row.keyHash)   -> else 401
-> derive { orgId, scopes } and inject as the tenant context
-> handler asserts required scope -> else 403
```
This yields the same `{ orgId }` contract `requireOrg()` produces, so downstream Prisma `where: { orgId }` filters are reused unchanged. Best-effort `lastUsedAt` update should be throttled (e.g. at most once/minute per key) to avoid a write per request on serverless.

**OAuth2 (deferred, Strategic Bet — see §10 picks rationale).** When third-party *apps acting on behalf of a user* are needed (a marketplace), add **OAuth2 Authorization Code + refresh tokens** for user-delegated access, and **Client Credentials** for pure M2M. Until then, per-tenant API keys cover server-to-server integrations — "Use API keys for server-to-server calls… and simple integrations where you control both ends," reserve OAuth "whenever user delegation is required: third-party API integrations, multi-tenant SaaS platforms." [API auth comparison]

**(3) Reference evidence.** Hash with SHA-256, never store plaintext, use identifiable prefixes + prefix index for lookup — [Zuplo: API key authentication](https://zuplo.com/learning-center/how-to-implement-api-key-authentication), [Bomberbot: secure API keys](https://www.bomberbot.com/api/best-practices-for-building-secure-api-keys-a-comprehensive-guide/), [OneUptime: API key management](https://oneuptime.com/blog/post/2026-02-20-api-key-management-best-practices/view). Bearer-token + scopes model — [HubSpot private app auth/scopes](https://trio.dev/hubspot-api/). API-keys-vs-OAuth decision — [APIScout: OAuth2 vs API Keys vs JWT](https://apiscout.dev/blog/api-authentication-oauth2-vs-api-keys-vs-jwt-2026), [Auth0: migrate API keys to OAuth2](https://auth0.com/blog/why-migrate-from-api-keys-to-oauth2-access-tokens/).

**(4) Effort: M** (API keys). Deps: new `ApiKey` Prisma model + migration; `src/lib/api-auth.ts` helper; key-management UI in settings (mint/revoke, show-once). OAuth2 is a separate **L**.

**(5) Tier: Foundation** (API keys + scopes). OAuth2: Strategic Bet.

---

## 3. Pagination — **cursor-based** (opaque cursor)

**(1) What it enables.** Stable, fast iteration over large tenant datasets for syncs/exports without offset drift or deep-offset DB cost.

**(2) Design.**
- Request params: `limit` (default `25`, max `100`) and `cursor` (opaque). Following Stripe's `starting_after` semantics — pass the last seen id to get the next page. [Stripe pagination]
- **Opaque cursor** = base64url of `{ "id": "<cuid>", "createdAt": "<iso>" }`. Tie-break sort on `(createdAt DESC, id DESC)` so a non-unique sort key still produces a total order; Prisma implements this with `cursor: { id }, skip: 1, take: limit + 1`. Decode → `where`/`orderBy`.
- **Response envelope** (Stripe-shaped list object):
```json
{
  "object": "list",
  "data": [ /* resources */ ],
  "has_more": true,
  "next_cursor": "eyJpZCI6ImNr..."
}
```
Fetch `limit + 1` rows; if the extra row exists, set `has_more: true`, drop it, emit `next_cursor` from the last returned row. [Stripe pagination][Pipedrive `next_cursor` in `additional_data`]
- Avoid `total` counts on list endpoints (expensive on Postgres at scale); offer counts only via a dedicated/aggregated endpoint if needed. All three benchmarks moved to cursors precisely because "there's no counting offsets in the database." [Stripe blog / Pipedrive]

**(3) Reference evidence.** Cursor pagination with `starting_after`/`has_more`/list envelope, "items won't be skipped or duplicated if new records are added… just pass the last id you received" — [Stripe API & idempotency blog summary](https://stripe.com/blog/idempotency) and [Stripe API Reference](https://docs.stripe.com/api). HubSpot `limit` (max 100) + `after` cursor — [HubSpot pagination guide](https://trio.dev/hubspot-api/). Pipedrive cursor + `next_cursor`, max limit 500 — [Pipedrive pagination](https://pipedrive.readme.io/docs/core-api-concepts-pagination).

**(4) Effort: S–M.** Deps: shared `paginate()` helper + cursor codec; relies on existing `createdAt` columns (already present on all CRM models).

**(5) Tier: Foundation.**

---

## 4. Filtering & sorting

**(1) What it enables.** Targeted reads (e.g. deals in a stage, contacts by company, activities due before a date) so integrators don't pull whole datasets.

**(2) Design.**
- **Allowlisted query filters** per resource, mapped to safe Prisma `where` clauses (never pass raw client input into Prisma). Examples:
  - `/contacts?companyId=...&email=...&updatedAt[gte]=2026-01-01T00:00:00Z`
  - `/deals?status=OPEN&stageId=...&value[gte]=1000`
  - `/activities?type=TASK&completed=false&dueAt[lte]=...`
- **Operator suffixes** for ranges/dates: `[gte] [lte] [gt] [lt]` (parsed into Prisma comparators). Keeps URLs cacheable vs a POST search body.
- **`updatedAt[gte]` is the key integration primitive** — it enables incremental "give me everything changed since my last sync" pulls (the canonical webhook/sync fallback). Backed by adding `@@index([orgId, updatedAt])` to synced models.
- **Sorting:** `sort=createdAt` / `sort=-value` (leading `-` = desc), allowlisted columns only; default `-createdAt`. Must stay consistent with the cursor tie-break (§3).
- **Full-text-ish search:** reuse the existing `contains … mode:"insensitive"` pattern from `globalSearch` (`src/server/actions/search.ts`) behind `?q=` for contacts/companies/deals. For richer filtering later, mirror HubSpot's `POST /search` with `filterGroups` (operator/propertyName/value). [HubSpot filtering]

**(3) Reference evidence.** HubSpot filtering via search `filterGroups` (`propertyName`, `operator`, `value`) — [HubSpot CRM search/filtering](https://trio.dev/hubspot-api/). Allowlist + server-side mapping is the standard guard against query injection — [SBB API best practices](https://schweizerischebundesbahnen.github.io/api-principles/restful/best-practices/).

**(4) Effort: M.** Deps: per-resource filter allowlists + operator parser; new composite indexes (esp. `(orgId, updatedAt)`).

**(5) Tier: Core.**

---

## 5. Versioning — **URL path `/v1`** now, date-pinning optional later

**(1) What it enables.** Freedom to evolve the API (additively now, breaking later) without shattering existing integrations.

**(2) Design.**
- **v1 = path versioning: `/api/v1/...`.** Lowest-friction, visible, cacheable, trivial to route in the App Router (`src/app/api/v1/<resource>/route.ts`). This is the de-facto entry standard and what HubSpot (`/crm/v3/...`) and Pipedrive (`/v1`, `/v2`) use. [HubSpot][Pipedrive]
- **Compatibility contract from day one** (Stripe's rules): treat as backward-compatible and ship *without* a version bump — adding resources, adding *optional* request params, adding response properties. Clients must ignore unknown fields. [Stripe versioning]
- **Breaking changes** (removing/renaming fields, changing types, tightening validation) ⇒ a new path version `/api/v2`, with `/v1` supported on a published deprecation window and `Deprecation`/`Sunset` headers.
- **Optional future upgrade — Stripe-style date pinning** as a Strategic Bet if/when change velocity is high: pin each API key to the version current at first use, allow per-request override via a `Smart-CRM-Version: 2026-06-20` header, and run version "transformers" to shape old responses. Powerful but heavy; not warranted for v1. [Stripe versioning]

**(3) Reference evidence.** Date-based versioning, account/key pinning, `Stripe-Version` header override, and the explicit list of backward-compatible (additive) changes — [Stripe: API versioning blog](https://stripe.com/blog/api-versioning) and [Stripe versioning ref summary](https://docs.stripe.com/api/versioning). Path versioning in practice — [HubSpot `/crm/v3`](https://trio.dev/hubspot-api/), [Pipedrive v1→v2 migration](https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide).

**(4) Effort: S** (path `/v1` + a compatibility policy doc). Date-pinning: **L**.

**(5) Tier: Foundation** (path versioning + additive policy). Date-pinning: Strategic Bet.

---

## 6. Rate limiting on serverless — **Upstash Redis sliding window**

**(1) What it enables.** Protects Postgres and ensures fair multi-tenant usage; gives integrators predictable `429` behavior with retry guidance.

**(2) Design.**
- **Why not in-memory:** Vercel serverless functions are ephemeral/horizontally scaled — no shared counter survives across invocations. Need a connectionless external store. **Upstash Redis** is HTTP-based (no persistent socket), purpose-built for serverless/edge, and "the only connectionless (HTTP based) rate limiting library." [Upstash ratelimit]
- **Algorithm: sliding window** via `@upstash/ratelimit` to avoid the fixed-window "burst at boundary" problem. [Upstash blog]
```typescript
// design sketch
const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(100, "60 s"),  // per API key, per minute (tune per tier)
  analytics: true,
  prefix: "smartcrm:api",
  ephemeralCache: new Map(),  // in-process cache while function is "hot" -> fewer Redis round-trips
});
const { success, limit, remaining, reset } = await ratelimit.limit(apiKeyId);
```
- **Identifier = `ApiKeyId`** (per-tenant key), not IP — IPs are shared/spoofable and don't reflect the tenant. Optionally a coarse per-org ceiling on top.
- **Tiered limits** (Pipedrive-style): a per-key sustained limit (e.g. 100 req/min) plus a short **burst** guard (e.g. small rolling window) for the heaviest endpoints (search). [Pipedrive token/burst model]
- **Response on limit:** `429 Too Many Requests` + headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`. Map directly from `limit/remaining/reset`.
- **Resilience:** fail-open with a short Redis timeout so a rate-limiter outage doesn't take down the API; declare the limiter outside the handler so the **ephemeral cache** survives warm invocations. [Upstash production guidance]
- **Where it runs:** in each route handler (or a shared wrapper) before touching Prisma. Edge middleware is an option but our handlers use Node-only Prisma; keeping the limiter in the Node handler avoids an edge/runtime split for v1.

**(3) Reference evidence.** Connectionless HTTP Redis for serverless, `slidingWindow`/`fixedWindow`/`tokenBucket`, `Ratelimit.slidingWindow(...)`, `limit()` returning `{ success, limit, remaining, reset }`, `ephemeralCache`, fail-open timeout, deny lists — [Upstash ratelimit-js (GitHub)](https://github.com/upstash/ratelimit-js), [Upstash: serverless rate limiting](https://upstash.com/blog/upstash-ratelimit), [Upstash: Next.js rate limiting](https://upstash.com/blog/nextjs-ratelimiting). Tiered sustained + burst limits — [Pipedrive rate limiting](https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting).

**(4) Effort: S–M.** Deps: Upstash account + `UPSTASH_REDIS_REST_URL/TOKEN` env (add an `env.ts` validator while at it); `@upstash/ratelimit` + `@upstash/redis`; shared limiter wrapper.

**(5) Tier: Core** (a public API without rate limiting is operationally unsafe, but it can ship a beat after auth + read endpoints).

---

## 7. Idempotency keys on writes

**(1) What it enables.** Safe client retries (network blips, serverless timeouts) on `POST`/`PATCH`/`DELETE` without creating duplicate contacts/deals or double-applying updates.

**(2) Design.**
- Clients send an `Idempotency-Key` header (recommend a v4 UUID) on mutating requests. [Stripe idempotency]
- **Store-and-replay:** persist the key + a fingerprint of the request + the eventual status code and response body. On a repeat with the same key: replay the saved response (including the original error). "Stripe's idempotency works by saving the resulting status code and body of the first request… subsequent requests with the same key return the same result, including 500 errors." [Stripe idempotency]
- **Conflict guard:** if the same key arrives with a *different* request body fingerprint → `400/409` (key reuse with different payload). If a first request is still in flight → `409` (concurrent replay).
- **Scope the key per (orgId, key)** so tenants can't collide.
- **TTL:** expire records after 24h (Stripe's window) via `expiresAt` + a sweep/Postgres TTL job. [Stripe idempotency]
- **Prisma model sketch:**
```prisma
model IdempotencyKey {
  id           String   @id @default(cuid())
  orgId        String
  key          String                       // client-supplied Idempotency-Key
  method       String                       // "POST" | "PATCH" | "DELETE"
  path         String                       // "/api/v1/contacts"
  requestHash  String                       // SHA-256 of canonical request body
  statusCode   Int?                         // null while in-flight
  responseBody Json?                        // replayed verbatim
  createdAt    DateTime @default(now())
  expiresAt    DateTime                     // createdAt + 24h

  @@unique([orgId, key])                    // first-writer-wins; retries hit the same row
  @@index([expiresAt])
}
```
- **Flow:** `INSERT … ON CONFLICT DO NOTHING` on `(orgId, key)` → if you won the insert, do the work and write back `statusCode/responseBody`; if a row already exists, compare `requestHash` and either replay or `409`. Only required on non-idempotent verbs (`GET`/idempotent `PATCH` of full objects are naturally safe, but supporting the header everywhere is friendlier).

**(3) Reference evidence.** `Idempotency-Key` header (v4 UUID), save status+body of first request and replay (incl. errors) for repeats, ~24h key retention — [Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests) and [Stripe blog: designing robust APIs with idempotency](https://stripe.com/blog/idempotency).

**(4) Effort: M.** Deps: `IdempotencyKey` model + migration; middleware wrapper around write handlers; canonical-body hashing; TTL sweep.

**(5) Tier: Core.**

---

## 8. Error format — single consistent JSON envelope

**(1) What it enables.** Machine-parseable, debuggable failures so integrators can branch on error type/code and surface field-level validation — reusing the `fieldErrors` concept already produced by `ActionResult`.

**(2) Design.**
- **One envelope** (Stripe-style nested `error` object), distinct from the success body:
```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_failed",
    "message": "email must be a valid email address",
    "param": "email",
    "field_errors": { "email": ["Invalid email"] },
    "request_id": "req_01H..."
  }
}
```
- **Status codes:** `400` malformed/validation, `401` missing/invalid key, `403` valid key lacking the required scope, `404` not found *or wrong tenant* (return 404 not 403 to avoid leaking existence across tenants), `409` idempotency/version conflict, `422` semantic validation if distinguished, `429` rate limited, `5xx` server. Mirrors Stripe's status taxonomy. [Stripe errors]
- **Error `type` taxonomy:** `invalid_request_error`, `authentication_error`, `permission_error`, `rate_limit_error`, `idempotency_error`, `api_error`. Stable machine `code`s within each.
- **Bridge from existing code:** map `fail(error, fieldErrors)` → this envelope (`message` ← `error`, `field_errors` ← `fieldErrors`), and map thrown `AuthError`/`TenantError`/`ForbiddenError` (from `src/lib/tenant.ts` / `rbac.ts`) → `401`/`403` respectively in a shared error handler. Zod `safeParse` failures → `400` with `field_errors`.
- Always include a `request_id` (generate per request) and echo it in a `Request-Id` header for support/debugging.

**(3) Reference evidence.** Nested `error` object with `type`/`code`/`message`/`param`, status-code taxonomy (400/401/402/403/404/409/429/5xx), and error `type`s — [Stripe API errors](https://docs.stripe.com/api/errors) (per Stripe docs summary) and patterns echoed in [DEV: why Stripe's API is the gold standard](https://dev.to/yukioikeda/why-stripes-api-is-the-gold-standard-design-patterns-that-every-api-builder-should-steal-3ikk).

**(4) Effort: S.** Deps: shared `apiError()` serializer + a route-level try/catch wrapper mapping existing error classes.

**(5) Tier: Foundation** (cheap, and every other capability depends on a consistent error shape).

---

## 9. Reuse Zod schemas + tenant/role scoping (shared `withApiKey` wrapper)

**(1) What it enables.** Keeps the public API DRY with the existing app — same validation, same tenant isolation, same domain rules — so the two surfaces can't drift.

**(2) Design.**
- **Extract schemas into a shared module** (e.g. `src/server/schemas/*` or co-located exports) and split UI vs API variants. The current schemas encode form quirks: `email: z.string().email().optional().or(z.literal(""))` and `value: z.coerce.number()` (`contacts.ts`, `deals.ts`). For JSON, define API schemas where optional means omitted/`null` (not `""`) and `value` is a validated number/decimal-string. Have the server-action form schemas and the API schemas share a common base (`z.object` core) so business rules (max lengths, enums) live in one place.
- **Refactor server actions to accept already-parsed input** (or expose a `core` function) so route handlers and actions call the *same* domain logic instead of duplicating Prisma writes. This is the highest-leverage refactor: today `createContact` both validates *and* writes; splitting "validate" from "persist(orgId, data)" lets the API reuse persistence with scope checks layered on.
- **Tenant scoping reuse:** the API-key context yields `{ orgId, scopes }` exactly like `requireOrg()` yields `{ orgId, role }`. Every Prisma call keeps its `where: { orgId }`. A single composable wrapper:
```typescript
// design sketch — src/lib/api-handler.ts
export const withApiKey = (scope: Scope, handler) => async (req) => {
  const ctx = await authenticateApiKey(req);          // 401 on bad key
  if (!ctx.scopes.includes(scope)) return apiError(403, "permission_error", ...);
  const rl = await ratelimit.limit(ctx.apiKeyId);      // 429
  if (!rl.success) return rateLimited(rl);
  return withIdempotency(req, ctx, () => handler(req, ctx)); // for writes
};
```
- **Scopes vs roles:** API keys use **scopes** (machine least-privilege), independent of the human `Role` ladder. (A key minted by a MEMBER could still be `*.read` only.) This is a deliberate improvement over the current actions, which skip `requireRole` entirely.

**(3) Reference evidence.** Internal codebase: `src/server/actions/{contacts,deals,companies,activities}.ts` (co-located, UI-shaped Zod), `src/lib/tenant.ts` (`requireOrg`), `src/lib/rbac.ts` (`requireRole`), `src/lib/action-result.ts` (`fieldErrors`), `src/app/(app)/contacts/export/route.ts` (route handler reading `requireOrg`). Scope-based least privilege — [HubSpot scopes](https://trio.dev/hubspot-api/); "request only the scopes your app truly needs."

**(4) Effort: M.** Deps: schema extraction/refactor; split validate/persist in actions; the `withApiKey` wrapper. Touches existing code, so coordinate to avoid regressions.

**(5) Tier: Core.**

---

## 10. OpenAPI spec + developer docs & SDK strategy

**(1) What it enables.** Self-serve onboarding: interactive reference, typed clients, contract tests — the difference between an API that's adopted and one that's ignored.

**(2) Design.**
- **OpenAPI 3.1 as the source of truth.** Generate the spec *from* the Zod API schemas (e.g. `zod-to-openapi`/`@asteasolutions/zod-to-openapi`) so the docs can't drift from validation. Document: auth (Bearer API key), scopes per operation, pagination params, filter params, error envelope, idempotency + rate-limit headers.
- **Hosted reference docs** rendered from the spec (Scalar / Redocly / Stripe-style three-pane). Include copy-paste `curl` and language snippets.
- **SDK strategy (phased):**
  - v1: ship the **OpenAPI spec** + let users generate clients (openapi-generator) — near-zero cost, broad language coverage.
  - Later (Strategic Bet): a first-party **TypeScript SDK** generated from the spec (typed methods, auto-pagination iterator, automatic `Idempotency-Key` injection, retry-on-429 with `Retry-After`) — the ergonomics that make Stripe's SDKs loved.
- **Sandbox/test mode** (`sk_test_` keys against seed data) is the docs companion that lets integrators build without touching prod — sequence after core endpoints.
- **Postman/Insomnia collection** exported from the spec for quick exploration.

**(3) Reference evidence.** Stripe's reference + idempotency/versioning docs are the bar for developer experience — [Stripe API Reference](https://docs.stripe.com/api). HubSpot ships official v3 client libraries generated around the API — [HubSpot API guide](https://trio.dev/hubspot-api/) / [hubspot-api-python](https://github.com/HubSpot/hubspot-api-python). General API-DX guidance — [SBB REST best practices](https://schweizerischebundesbahnen.github.io/api-principles/restful/best-practices/).

**(4) Effort: M** (spec + hosted docs). First-party TS SDK: **L**.

**(5) Tier: Core** (OpenAPI + docs). TS SDK & sandbox: Strategic Bet.

---

## Summary table

| # | Capability | Effort | Tier |
|---|------------|--------|------|
| 1 | REST `/api/v1` (not GraphQL) | M | Foundation |
| 2 | Hashed API keys + scopes (OAuth2 later) | M (OAuth2 L) | Foundation (OAuth2 Strategic Bet) |
| 3 | Cursor pagination | S–M | Foundation |
| 4 | Filtering & sorting (`updatedAt[gte]` incremental sync) | M | Core |
| 5 | Versioning — path `/v1` + additive policy (date-pin later) | S (date-pin L) | Foundation (date-pin Strategic Bet) |
| 6 | Rate limiting — Upstash Redis sliding window | S–M | Core |
| 7 | Idempotency keys on writes | M | Core |
| 8 | Consistent error envelope | S | Foundation |
| 9 | Reuse Zod schemas + tenant/scope wrapper | M | Core |
| 10 | OpenAPI + docs (+ TS SDK/sandbox later) | M (SDK L) | Core (SDK Strategic Bet) |

---

## Top 3 picks

1. **Hashed API keys + scopes (`ApiKey` model, SHA-256 + lookup prefix, `withApiKey` wrapper).** Nothing programmatic is possible — or safe — without authenticated, revocable, least-privilege, per-tenant access. It also reuses the existing `requireOrg()` `{ orgId }` contract directly and finally adds the authorization layer the current server actions lack. *(Foundation, Effort M.)*

2. **REST `/api/v1` core resources with cursor pagination + consistent error envelope.** The thin, predictable, cacheable surface over the logic already in `src/server/actions/*` — the lowest-friction choice for third-party integrators and the dependent webhooks roadmap, and the foundation every other capability attaches to. *(Foundation, Effort M; pagination S–M, errors S.)*

3. **Rate limiting (Upstash Redis sliding window) + idempotency keys on writes.** The operational safety pair: protects Postgres and enforces fair multi-tenant use on serverless where in-memory limiting is impossible, while letting integrators retry writes without creating duplicate records — both directly modeled on the Stripe/Pipedrive benchmarks. *(Core, Effort S–M + M.)*
