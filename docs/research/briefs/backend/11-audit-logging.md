# Smart-CRM — Audit Logging & Record History (Backend Design Brief)

**Author:** Backend/Platform engineering
**Date:** 2026-06-20
**Scope:** RESEARCH / DESIGN ONLY — no repo changes, no migrations. Designs reference the existing codebase but nothing here is applied.

---

## Context: what the codebase gives us today

Findings from reading the repo (all paths absolute):

- **Single capture chokepoint.** Every mutation lives in `src/server/actions/*` and begins with `await requireOrg()` from `/home/user/Smart-CRM/src/lib/tenant.ts`, which returns `{ userId, orgId, role }`. This is a clean, uniform actor + tenant context already present at every write. (Files: `deals.ts`, `contacts.ts`, `companies.ts`, `activities.ts`, `tags.ts`, `org.ts`, `auth.ts`.)
- **Bare Prisma singleton.** `/home/user/Smart-CRM/src/lib/db.ts` is a plain `new PrismaClient(...)` with no `$extends` and no middleware — a greenfield insertion point for a query extension.
- **Mixed mutation styles matter for capture.**
  - Row-returning: `db.deal.create/update`, `db.contact.create/update`, `db.company.create/update`, `db.activity.create` — these return the row, so a "after" image is free; a "before" image needs a pre-read (the actions already do `findFirst` before `update`, so the before-image is often in hand).
  - Count-only: `setDealStatus` (`updateMany`), every `delete*` (`deleteMany`), `setContactTags` (`deleteMany`+`createMany` in a `$transaction`). These return `{ count }` only — **no before/after row**, so auto-capture via a generic extension cannot diff them without an explicit pre-read.
- **`$transaction` is in use** (`signUpAction`, `inviteMember`, `setContactTags`). This directly collides with the official Prisma audit extension pattern, which "wraps every query in a new batch transaction" and warns that explicit `prisma.$transaction()` "may not work as intended" ([Prisma audit-log-context](https://github.com/prisma/prisma-client-extensions/tree/main/audit-log-context)). Capture design must be transaction-aware.
- **No DB Session rows for logins.** NextAuth uses `session: { strategy: "jwt" }` (`/home/user/Smart-CRM/src/lib/auth.config.ts`) with Credentials in `/home/user/Smart-CRM/src/lib/auth.ts`. Login success/failure must be captured in the `authorize()` callback / NextAuth `events`, not derived from the `Session` table.
- **IP/UA are reachable.** Server actions can call `headers()` from `next/headers`; on Vercel `x-forwarded-for` / `x-real-ip` and `user-agent` are populated.
- **Export precedent exists.** `/home/user/Smart-CRM/src/lib/csv.ts` (`toCsv`) is already used for data export and is reusable for compliance export.
- **A timeline UI slot already exists.** `/home/user/Smart-CRM/src/app/(app)/deals/[id]/page.tsx` renders an "Activity" sidebar — the natural host for a record history feed.

**Headline recommendation:** application-level capture, centralized in a thin helper invoked from server actions (not Postgres triggers, not a fully-implicit Prisma extension). Rationale below under Capability 2; the deciding factor is that with a pooled connection the DB sees one role (`app_user`), so DB-native auditing records the *database* user, not the *human* — "the identity is the database user, not the human, as most applications and ops scripts connect as app_user or admin" ([Neon/Bytebase on pgAudit](https://neon.com/blog/postgres-logging-vs-pgaudit)). Our human + org + role + request context only exists in the app layer.

---

## Capability 1 — Append-only `AuditLog` model (the spine)

**What it enables.** A single immutable who-did-what-to-what-when table spanning all entities: actor, org (tenant), entity type+id, action, before/after diff, IP/UA, timestamp. Powers every other capability (timeline, security log, export, tamper-evidence).

**Design — Prisma sketch:**

```prisma
enum AuditAction {
  CREATE
  UPDATE
  DELETE
  STATUS_CHANGE      // e.g. setDealStatus, toggleActivityComplete
  LOGIN_SUCCESS
  LOGIN_FAILURE
  ROLE_CHANGE
  MEMBER_INVITE
  MEMBER_REMOVE
  EXPORT
}

model AuditLog {
  id          String       @id @default(cuid())
  orgId       String?      // nullable: LOGIN_FAILURE may precede org resolution
  actorId     String?      // null for system/anonymous; SetNull keeps log if user deleted
  actorEmail  String?      // denormalized snapshot — survives user deletion (GDPR-safe label)
  action      AuditAction
  entity      String       // "Deal" | "Contact" | "Company" | "Activity" | "Membership" | "Auth" ...
  entityId    String?      // null for non-entity events (login)
  summary     String?      // human one-liner for fast timeline render, e.g. "Stage: Lead -> Qualified"
  diff        Json?        // field-level change map (format in Capability 4)
  metadata    Json?        // ip, ua, requestId, source ("web"|"api"|"import")
  createdAt   DateTime     @default(now())

  // Tamper-evidence (Capability 6) — nullable so it can ship later
  seq         BigInt?      // per-org monotonic sequence
  prevHash    String?
  hash        String?

  org   Organization? @relation(fields: [orgId], references: [id], onDelete: Cascade)
  actor User?         @relation("AuditActor", fields: [actorId], references: [id], onDelete: SetNull)

  @@index([orgId, entity, entityId, createdAt])   // per-record timeline
  @@index([orgId, createdAt])                      // org-wide feed + export window
  @@index([orgId, actorId, createdAt])             // "everything user X did"
  @@index([orgId, action, createdAt])              // security-event filtering
}
```

Notes:
- **`Json` (JSONB) for `diff`/`metadata`** so one table serves all entity types without schema mirroring — "PostgreSQL's schema-less JSONB data type ... allows multiple tables' audit history to be stored in a single audit table" ([Elephas](https://elephas.io/audit-logging-using-jsonb-in-postgres/)).
- **Denormalize `actorEmail` + `summary`** so the timeline renders without N joins and so a deleted actor still has a readable label.
- **`onDelete: SetNull` on actor, `Cascade` on org** — deleting a tenant removes its logs (GDPR account closure), but deleting a user must not erase history of what they did.
- Append-only is enforced at the app layer (no update/delete code path) and hardened in Capability 6.

**Reference evidence.** Single append-only JSONB table handling many entities and ~100M events/month with proper indexing ([Jsonic JSON Audit Trail](https://jsonic.io/guides/json-audit-trail), [Elephas](https://elephas.io/audit-logging-using-jsonb-in-postgres/)). Column shape mirrors the canonical Supabase `record_version` (record id, `old_record`/`new_record`, `op`, `ts`, table identity) ([Supabase: Postgres Auditing in 150 lines of SQL](https://supabase.com/blog/postgres-audit)).

**Effort:** **S** (one model + migration + indexes). **Deps:** none.
**Tier:** **Foundation.**

---

## Capability 2 — Capture mechanism: app-level `audit()` helper in server actions

**What it enables.** Reliable population of `AuditLog` with full human/org/request context, correctly handling the count-only mutations and `$transaction` paths the codebase already uses.

**Design.** A `recordAudit(tx, { action, entity, entityId, before, after, ... })` helper in a new `src/lib/audit.ts`, called explicitly inside each server action. Pattern:

1. Action already calls `requireOrg()` → actor/org/role in scope.
2. Read request context once: `const h = await headers(); ip = h.get("x-forwarded-for")?.split(",")[0]; ua = h.get("user-agent")`.
3. For updates the action already does `findFirst` (the before-image); pass `before` + the returned row as `after`.
4. **Write the audit row in the same transaction as the mutation** so the log is atomic with the change (no orphan logs, no lost logs). Wrap mutation+audit in `db.$transaction(async (tx) => { ...; await recordAudit(tx, ...) })`. This composes with the existing `$transaction` usages rather than fighting them.
5. Diff is computed by `recordAudit` from `before`/`after` (format in Capability 4); skip the write if the diff is empty.

**Why explicit-in-action over the two alternatives:**

| Approach | Verdict for Smart-CRM |
|---|---|
| **Postgres triggers** (`set_config('app.current_user_id', ...)` + trigger reads `current_setting`) | Rejected as primary. Captures even out-of-app writes and is hard to bypass, but with a pooled connection the human identity isn't in the DB session, and passing org/role/IP/UA/requestId through `SET LOCAL` for every field is brittle. Trigger auditing records the DB user, not the human ([Vlad Mihalcea](https://vladmihalcea.com/postgresql-audit-logging-triggers/), [Bytebase](https://www.bytebase.com/blog/postgres-audit-logging/)). |
| **Implicit Prisma `$extends` query extension** (auto-log all create/update/delete) | Rejected as primary. The official example wraps every op in its own batch transaction and explicitly breaks `prisma.$transaction()` ([Prisma audit-log-context](https://github.com/prisma/prisma-client-extensions/tree/main/audit-log-context)) — and Smart-CRM uses `$transaction`. Worse, `updateMany`/`deleteMany` (our `setDealStatus`, all `delete*`) return only `{ count }`, so the extension has no before/after to diff. |
| **Explicit `recordAudit()` in actions** (chosen) | Full human+org+role+IP+UA+source context, correct diffs for count-only ops (action does the pre-read), atomic with the mutation, transaction-friendly, and easy to unit-test. Cost: one call site per mutation (~15 sites) and the discipline to not forget one. |

**Hybrid hardening (optional, later):** keep a *defensive* Prisma `$extends` that asserts a "no silent DML" rule — if a write touches an audited model with no `recordAudit` in the same request, log a warning/metric. Gives drift detection without making the extension the source of truth. For true "even-if-the-app-is-bypassed" coverage (DBA running raw SQL), add pgAudit at the infra layer as a second, coarser trail — the recommended hybrid: pgAudit for infra compliance + app-level for business context ([Neon](https://neon.com/blog/postgres-logging-vs-pgaudit), [Bytebase](https://www.bytebase.com/blog/database-audit-logging/)).

**Reference evidence.** Prisma query extensions intercept writes via `$allOperations(operation, model, args, query)` and can run side-effect queries ([Prisma Client extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions)); the official audit example's transaction caveat ([repo](https://github.com/prisma/prisma-client-extensions/tree/main/audit-log-context)). App-level carries the context infra-level cannot (ticket/approval/human identity) ([Bytebase](https://www.bytebase.com/blog/database-audit-logging/)).

**Effort:** **M** (helper + ~15 call sites + header plumbing). **Deps:** Capability 1.
**Tier:** **Foundation.**

---

## Capability 3 — Per-record activity/history timeline UI feed

**What it enables.** On any Deal/Contact/Company/Activity detail page, a reverse-chronological "History" feed: "Pat changed Stage Lead → Qualified · 2h ago", "Sam updated phone · yesterday". This is the user-visible payoff of the audit spine and the Salesforce "Field History" analogue.

**Design.**
- Server query: `db.auditLog.findMany({ where: { orgId, entity, entityId }, orderBy: { createdAt: "desc" }, take: 50 })` — served by the `@@index([orgId, entity, entityId, createdAt])`. Cursor-paginate on `createdAt`+`id` for "load more".
- Render each row from denormalized `summary` + `actorEmail` + relative time; expand to show the `diff` field map (old → new per field).
- Drop the component into the existing "Activity" aside in `/home/user/Smart-CRM/src/app/(app)/deals/[id]/page.tsx` (and the contact/company detail pages), as a second tab or section beside the existing Activity list. Note this is *record history* (audit-derived) vs the existing user-authored `Activity` notes/tasks — keep them distinct.
- An org-wide feed (`/settings/audit`, ADMIN+ via `requireRole`) reuses the `@@index([orgId, createdAt])` and `@@index([orgId, actorId, createdAt])` for filtering by user/action/date.

**Reference evidence.** This mirrors Salesforce **Field History Tracking** (per-record, per-field old/new value, who, when), which standard orgs retain ~18 months and which tracks up to **20 fields per object**; **Field Audit Trail** raises this to **10 years** and **60 fields per object** ([Flosum](https://www.flosum.com/blog/salesforce-field-audit-trail), [Salesforce Field Audit Trail docs](https://developer.salesforce.com/docs/atlas.en-us.field_history_retention.meta/field_history_retention/field_audit_trail.htm)). Field-level history is the right model when investigators repeatedly ask "who changed the phone number?" ([Bytebase](https://www.bytebase.com/blog/database-audit-logging/)).

**Effort:** **M** (one query + a reusable timeline component + placement on 3-4 detail pages + an admin feed page). **Deps:** Capabilities 1-2 (needs data first).
**Tier:** **Core.**

---

## Capability 4 — Field-level diff format

**What it enables.** A consistent, queryable representation of *exactly which fields changed* so the timeline can show old→new and so "show me every change to `value`" is answerable.

**Design.** Store a compact object map in `diff` (JSONB), keyed by changed field, plus a denormalized `summary` string:

```jsonc
// UPDATE diff
{
  "value":   { "old": "5000.00", "new": "7500.00" },
  "stageId": { "old": "stg_lead", "new": "stg_qualified" }
}
// CREATE: { "<field>": { "old": null, "new": <value> }, ... }  (or store after-snapshot only)
// DELETE: store the final snapshot under metadata.snapshot for recoverability
```

- Computed by `recordAudit` via a shallow field-by-field compare of `before`/`after`, after normalizing types (`Decimal`→string, `Date`→ISO) so Prisma `Decimal`/`DateTime` compare correctly. Empty diff ⇒ skip write.
- **Redaction list**: never write `passwordHash` or other secrets into a diff; `recordAudit` strips a denylist (and ideally takes an allowlist of auditable fields per entity).
- Industry idiom is "store the changed fields, not whole rows" on UPDATE, with INSERT recording the full new row as the change ([Supabase](https://supabase.com/blog/postgres-audit), [pg-audit-json](https://github.com/m-martinez/pg-audit-json)). JSON-Patch is an alternative wire format ([Prisma audit patterns discussion](https://medium.com/@gayanper/implementing-entity-audit-log-with-prisma-9cd3c15f6b8e)); the `{old,new}` map is simpler to render and adequate here.

**Reference evidence.** Changed-fields-only-on-UPDATE, full-row-on-INSERT pattern ([Supabase Postgres audit](https://supabase.com/blog/postgres-audit)); JSONB diff/snapshot split at the Prisma layer ([Medium: Entity Audit Log with Prisma](https://medium.com/@gayanper/implementing-entity-audit-log-with-prisma-9cd3c15f6b8e)).

**Effort:** **S** (a diff util + redaction denylist; unit-testable in isolation). **Deps:** Capability 2.
**Tier:** **Foundation.**

---

## Capability 5 — Security / authentication event log

**What it enables.** Login success/failure, logout, password change, role changes, invites/removals, and exports — the access-and-privilege trail SOC2 expects (CC7.x). Feeds anomaly detection ("5 failed logins then success from a new IP").

**Design.** Reuse the same `AuditLog` with auth-specific actions (`LOGIN_SUCCESS`, `LOGIN_FAILURE`, `ROLE_CHANGE`, `MEMBER_INVITE`, `MEMBER_REMOVE`, `EXPORT`).
- **Login events** can't come from the `Session` table (JWT strategy). Emit from NextAuth `events.signIn` / `events.signOut` and from a failed-`authorize()` branch in `/home/user/Smart-CRM/src/lib/auth.ts`. `LOGIN_FAILURE` has `actorId=null`, `actorEmail=<attempted email>`, `orgId=null`, IP/UA in `metadata`.
- **Privilege events** are already at clean call sites in `/home/user/Smart-CRM/src/server/actions/org.ts`: `changeMemberRole`, `removeMember`, `inviteMember` — capture old→new role.
- **Export events** (Capability 7) self-audit as `EXPORT`.
- For high-frequency `LOGIN_FAILURE` (credential-stuffing), consider isolating into a partition (Capability 8) or a separate `SecurityEvent` table if volume dwarfs business audits; start unified to keep one queryable trail.

**Reference evidence.** SOC 2 CC7.3 expects orgs to evaluate security events for whether they could/did result in failure ([emergentmind: immutable audit log](https://www.emergentmind.com/topics/immutable-audit-log)). Auth events are the canonical security-log content; DB-native logging misses the human actor, reinforcing app-layer capture here ([Neon](https://neon.com/blog/postgres-logging-vs-pgaudit)).

**Effort:** **M** (NextAuth events wiring + failure-path capture + role/invite call sites). **Deps:** Capabilities 1-2.
**Tier:** **Core.**

---

## Capability 6 — Tamper-evidence (hash-chained, append-only enforcement)

**What it enables.** Cryptographic proof that historical entries weren't silently edited or deleted — the difference between "we have logs" and "we can prove the logs are intact" for an auditor.

**Design (layered, ship incrementally):**
1. **Append-only enforcement (cheap, do first).** No update/delete code path for `AuditLog`. Harden with a Postgres rule / RLS policy or a `BEFORE UPDATE OR DELETE` trigger that raises an exception, and grant the app role INSERT+SELECT only — "never update or delete audit rows, only insert" ([DEV: architecture behind tamper-proof audit logs](https://dev.to/robertatkinson3570/the-architecture-behind-tamper-proof-audit-logs-56ek)).
2. **Hash chain (medium).** On insert, compute `hash = HMAC_SHA256(secret, canonical(row) || prevHash)` where `prevHash` is the previous entry's hash for that org, and `seq` is a per-org monotonic counter. Each entry binds to its predecessor, so any edit/removal breaks the chain on verification. Serialize appends per org with a **Postgres advisory lock** (or a DB sequence) to avoid races producing a forked chain ([Tracehold: HMAC hash chain](https://tracehold.ai/blog/immutable-audit-log-hmac-hash-chain/), [AppMaster: tamper-evident trails](https://appmaster.io/blog/tamper-evident-audit-trails-postgresql)). Tradeoff: serialized writes cap append throughput — fine at CRM scale, partition the lock per-org to keep contention local.
3. **Periodic anchoring (optional, Strategic).** Publish the latest chain head (or a Merkle root) to append-only external storage / a timestamping service so even a DB-admin-with-secret can't rewrite undetectably ([emergentmind](https://www.emergentmind.com/topics/immutable-audit-log), [EvoMap: Merkle tamper-evidence](https://evomap.ai/asset/sha256:a1059b30f20705557585c1b527504697d2b3261c6362abb9fdcb4f0b2e87c7fb)).

The `seq`/`prevHash`/`hash` columns are already nullable in Capability 1 so steps 2-3 are additive.

**Reference evidence.** HMAC-SHA256 chain + canonical schema + advisory lock to prove the past is unchanged ([Tracehold](https://tracehold.ai/blog/immutable-audit-log-hmac-hash-chain/)); each entry stores `prev_hash`/`curr_hash`, anchoring roots externally makes alteration detectable ([emergentmind](https://www.emergentmind.com/topics/immutable-audit-log)); app-layer + RLS append-only enforcement ([AppMaster](https://appmaster.io/blog/tamper-evident-audit-trails-postgresql)).

**Effort:** **L** (canonical serialization, per-org locking, verification job, key management; anchoring is extra). **Deps:** Capabilities 1-2; a managed signing secret.
**Tier:** **Strategic Bet** (step 1 alone is Foundation-cheap; the chain is the bet).

---

## Capability 7 — Compliance export & access (GDPR / SOC2)

**What it enables.** Self-serve, scoped, *itself-audited* export of the trail: SOC2 evidence pulls, GDPR Article 15 "what do you have about me" / portability, and admin investigations.

**Design.**
- Server action `exportAuditLog({ from, to, entity?, actorId? })`, ADMIN/OWNER-gated via `requireRole`, org-scoped via `requireOrg`. Streams **CSV** through the existing `toCsv` in `/home/user/Smart-CRM/src/lib/csv.ts` (and JSON/NDJSON for machine ingest). Backed by `@@index([orgId, createdAt])`.
- The export action **logs itself** as an `EXPORT` audit event (who exported what window) — auditing the auditors.
- **GDPR data-subject report**: filter by `actorId`/`actorEmail` to produce one subject's activity; pair with the entity records to satisfy Article 15.
- **GDPR erasure tension (call out explicitly):** append-only logs can't delete by construction, conflicting with Article 17. Resolution options, in order of pragmatism: (a) store only identifiers + denormalized `actorEmail` (a label, not a profile) and minimize PII in `diff`; (b) on erasure, pseudonymize the actor label while keeping the structural event; (c) **crypto-shredding** — encrypt PII-bearing diff fields with a per-subject key and destroy the key on erasure, leaving integrity hashes (computed over ciphertext) intact ([VeritasChain: crypto-shredding & GDPR](https://veritaschain.org/blog/posts/2026-01-18-crypto-shredding-gdpr-mifid-ii-reconciliation/), [Granit: crypto-shredding](https://granit-fx.dev/blog/crypto-shredding-gdpr-erasure-without-deleting-rows/)). Note the legal caveat: whether crypto-shredding qualifies as "erasure" is jurisdiction-dependent and unsettled per recent EDPB guidance — design for it but get counsel sign-off ([Axiom: right-to-be-forgotten vs audit mandates](https://axiom.co/blog/the-right-to-be-forgotten-vs-audit-trail-mandates)).

**Reference evidence.** Regulators demand verifiable, immutable, retrievable trails generic logs don't provide ([Bytebase](https://www.bytebase.com/blog/database-audit-logging/)). Append-only vs Article-17 tension and crypto-shredding as the reconciliation ([VeritasChain](https://veritaschain.org/blog/posts/2026-01-18-crypto-shredding-gdpr-mifid-ii-reconciliation/), [Axiom](https://axiom.co/blog/the-right-to-be-forgotten-vs-audit-trail-mandates)).

**Effort:** **S** for CSV/JSON export + self-audit; **M** if crypto-shredding/erasure workflow is included. **Deps:** Capabilities 1-2; reuses `csv.ts`.
**Tier:** **Core** (export); crypto-shredding sub-feature is **Strategic Bet**.

---

## Capability 8 — Storage cost, retention & partitioning

**What it enables.** Keeps the highest-growth table in the system bounded and cheap, and encodes tiered retention (e.g. 18 months hot, longer cold) per the Salesforce default model.

**Design.**
- **Monthly range partitioning** on `createdAt` (`AuditLog_2026_06`, ...). Retention = **drop old partitions** (instant, no lock) instead of `DELETE` scans — "run simple partitioned database [drops] rather than expensive locked deletes on a central table"; monthly partitions make dropping old data efficient ([Jsonic](https://jsonic.io/guides/json-audit-trail), [Elephas](https://elephas.io/audit-logging-using-jsonb-in-postgres/)). Prisma doesn't manage partitions natively — declare the model, create partitions via raw SQL migration + a scheduled job (e.g. pg_partman or a Vercel cron).
- **BRIN index on `createdAt`** in addition to the btree composites: the table is append-only with naturally ascending timestamps, so BRIN is "many hundreds of times smaller than BTREE ... with faster lookup times" for time-range scans like export windows ([Jsonic](https://jsonic.io/guides/json-audit-trail)).
- **Retention policy as data**: per-entity retention (mirror Salesforce `HistoryRetentionPolicy`: default archive after **18 months**, max **10 years**) ([Flosum](https://www.flosum.com/blog/salesforce-field-audit-trail)). Hot partitions in Postgres; aged partitions optionally exported to object storage (cold tier) — analogous to Salesforce archiving into the `FieldHistoryArchive` Big Object rather than purging ([Salesforce Field Audit Trail docs](https://developer.salesforce.com/docs/atlas.en-us.field_history_retention.meta/field_history_retention/field_audit_trail.htm)).
- **Cost sizing**: a single JSONB audit table handles ~**100M events/month** with correct indexing ([Elephas](https://elephas.io/audit-logging-using-jsonb-in-postgres/)) — orders of magnitude beyond early Smart-CRM, so partitioning is about *future-proofing and clean retention*, not day-one necessity. Caveat: high-churn writes multiply rows and complicate reporting ([Bytebase](https://www.bytebase.com/blog/database-audit-logging/)), and per-row hash-chaining (Cap 6) adds write overhead — partition the chain per org.

**Reference evidence.** Monthly partitions + partition-drop retention + BRIN-on-timestamp for append-only audit tables ([Jsonic](https://jsonic.io/guides/json-audit-trail), [Elephas](https://elephas.io/audit-logging-using-jsonb-in-postgres/)). Salesforce 18-month-default → 10-year-max retention and archive-not-purge model ([Flosum](https://www.flosum.com/blog/salesforce-field-audit-trail), [Salesforce docs](https://developer.salesforce.com/docs/atlas.en-us.field_history_retention.meta/field_history_retention/field_audit_trail.htm)).

**Effort:** **M** (raw-SQL partition migration + scheduled create/drop job + BRIN index; retention-policy config). **Deps:** Capability 1; can be deferred until volume warrants.
**Tier:** **Core** (becomes Foundation at scale).

---

## Tier & effort summary

| # | Capability | Effort | Tier |
|---|---|---|---|
| 1 | Append-only `AuditLog` model | S | Foundation |
| 2 | App-level `audit()` capture in server actions | M | Foundation |
| 3 | Per-record history timeline UI | M | Core |
| 4 | Field-level diff format | S | Foundation |
| 5 | Security / auth event log | M | Core |
| 6 | Tamper-evidence (hash chain) | L | Strategic Bet |
| 7 | Compliance export + GDPR erasure | S–M | Core (crypto-shred = Bet) |
| 8 | Retention & partitioning | M | Core (Foundation at scale) |

---

## Top 3 picks

1. **Append-only `AuditLog` model + app-level `recordAudit()` capture (Caps 1+2+4).** The non-negotiable spine. Cheap (S/M), unlocks everything else, and the codebase is already shaped for it — one `requireOrg()` chokepoint per action and a bare `db.ts` ready for the helper. Explicit-in-action beats triggers/implicit-extension here because our pooled connection hides the human identity and our count-only `updateMany`/`deleteMany`/`$transaction` paths defeat generic auto-capture.
2. **Per-record history timeline UI (Cap 3).** The visible product payoff and the Salesforce Field-History parity feature customers expect; slots straight into the existing detail-page "Activity" aside and is the thing that makes audit logging *felt*, not just stored.
3. **Security/auth event log (Cap 5).** Highest compliance leverage per unit effort for a SOC2-sold platform — reuses the same table, captures login success/failure + role/membership changes at clean existing call sites, and (with Cap 6 step-1 append-only enforcement) is what an auditor actually asks to see.
