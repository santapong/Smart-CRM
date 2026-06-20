# Smart-CRM — Multi-Tenancy & Org Architecture Evolution

**Author:** Backend/platform engineering
**Date:** 2026-06-20
**Scope:** Teams/sub-teams, territories, record ownership, org switching, and data-isolation hardening (defense-in-depth beyond manual `orgId` filters).
**Status:** RESEARCH / DESIGN ONLY — no repo changes proposed for execution here.

---

## Current state (as-read from repo)

- **Tenant model:** `Organization` 1‑*‑* `User` via `Membership { userId, orgId, role: OWNER|ADMIN|MEMBER }` (`prisma/schema.prisma:70-98`). Flat — no teams, no hierarchy.
- **Scoping:** every business table carries `orgId` (`Company`, `Contact`, `Deal`, `Activity`, `Tag`, `PipelineStage`). Server actions call `requireOrg()` (`src/lib/tenant.ts:16-23`) which pulls `activeOrgId`+`role` from the NextAuth JWT, then **manually** add `where: { orgId }` to every Prisma call (e.g. `src/server/actions/deals.ts:26,52,77,91,99`).
- **Ownership today:** `Deal.ownerId` / `Activity.ownerId` are nullable `User` FKs (`schema.prisma:195,229`). Ownership is **recorded but not enforced** — any member of the org can read/edit any record (visibility == org membership). `Contact`/`Company` have no owner at all.
- **Active org:** `activeOrgId` lives in the JWT; set lazily in the `jwt` callback to the oldest membership, and updatable via NextAuth's `trigger === "update"` path (`src/lib/auth.ts:47-67`). There is **no server action** that validates a switch or persists a "last active org".
- **DB client:** single global `PrismaClient` (`src/lib/db.ts`), no extension/middleware, no RLS. Postgres 16 on Vercel serverless.

**Core risk:** isolation is one forgotten `where: { orgId }` away from a cross-tenant leak. `updateMany`/`deleteMany`/`findFirst` are correctly scoped today, but there is **zero structural guardrail** — a new action, a new engineer, or a `findUnique({ where: { id } })` (which ignores `orgId`) can leak. This is the #1 thing to harden.

> Naming note: this brief uses **`orgId`** as the tenant discriminator to match the existing schema. Where cited sources say `tenantId`/`companyId`, the mechanism is identical.

---

## Capability 1 — Tenant-isolation hardening: Prisma client extension (auto-inject + read guard)

**(1) What it enables.** A defense-in-depth layer so that *forgetting* `where: { orgId }` can no longer leak data. A request-scoped Prisma client auto-injects `orgId` into every `where`/`create`/`updateMany`/`deleteMany` for tenant-scoped models, and **fails closed** if no org context is set. This is the cheapest, Vercel-friendliest hardening and the foundation everything else builds on.

**(2) Design + isolation mechanism.**
Use a Prisma **client extension** with `query.$allModels.$allOperations` (the modern, non-deprecated successor to `$use` middleware). Build a per-request client bound to the resolved `orgId` from `requireOrg()`.

```ts
// src/lib/db-scoped.ts  (sketch)
const TENANT_MODELS = new Set([
  "Company","Contact","Deal","Activity","Tag","PipelineStage","ContactTag",
]);

export function forOrg(orgId: string) {
  return db.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);

          // Reads + bulk writes: force orgId into the filter.
          if (["findFirst","findMany","findUnique","count","aggregate",
               "updateMany","deleteMany","groupBy"].includes(operation)) {
            (args as any).where = { ...(args as any).where, orgId };
          }
          // findUnique by PK ignores extra where → rewrite to findFirst.
          if (operation === "findUnique") {
            return (query as any)({ ...args, where: { ...(args as any).where, orgId } });
          }
          // Single-row creates: stamp orgId.
          if (operation === "create") {
            (args as any).data = { orgId, ...(args as any).data };
          }
          if (operation === "createMany") {
            const d = (args as any).data;
            (args as any).data = Array.isArray(d)
              ? d.map((r: any) => ({ orgId, ...r })) : { orgId, ...d };
          }
          return query(args);
        },
      },
    },
  });
}
```

Then `requireOrg()` returns `{ ...ctx, db: forOrg(orgId) }` and actions use `ctx.db.deal.findMany()` with no manual `orgId`. **Caveat from Prisma's own example:** the extension wraps work and "explicitly running transactions … may not work as intended" — interactive `$transaction` callbacks need the scoped client threaded through carefully ([Prisma RLS example README](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security)). `findUnique`/`upsert` are the sharp edges (composite-PK semantics, `where`-not-merged), so the rewrite-to-`findFirst` shim above is essential — this is exactly the gap that makes app-layer-only approaches leak.

**Migration path:** add the extension, keep manual `where: { orgId }` (harmless redundancy), then delete the manual filters table-by-table behind tests. No DB migration. **This does not replace RLS** (Capability 2) — it's the same trust boundary as the app, so a raw query or a bug in the extension still leaks. It's a 90%-value, 10%-effort first step.

**(3) Reference evidence.**
- Prisma's official client-extensions repo ships an RLS/tenant example and documents the transaction caveat ([github.com/prisma/prisma-client-extensions](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security)).
- `$allModels.$allOperations` injecting `where.tenantId` is the documented community pattern; extensions reuse the existing connection pool, no per-request pool ([Prisma docs — query extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query); [Prisma discussion #20553](https://github.com/prisma/prisma/discussions/20553)).
- A `skip` flag on operations lets you bypass injection for admin/cross-tenant jobs ([dev.to — NestJS+Prisma multi-tenancy](https://dev.to/moofoo/nestjspostgresprisma-multi-tenancy-using-nestjs-prisma-nestjs-cls-and-prisma-client-extensions-ok7)).

**(4) Effort:** **S–M**. Deps: none (pure app layer). Risk concentrated in `findUnique`/`upsert`/interactive-tx call sites — needs a test sweep.

**(5) Tier:** **Foundation.**

---

## Capability 2 — Postgres Row-Level Security (RLS) with session GUC — the real trust boundary

**(1) What it enables.** Isolation enforced **by the database**, below the app. Even raw SQL, a buggy extension, an ad-hoc analytics query, or a future service hitting the same DB cannot cross tenants. This is the only mechanism that is truly defense-in-depth (a different trust boundary than the app), and the bar Salesforce-grade SaaS holds itself to.

**(2) Design + isolation mechanism.**
Enable RLS per tenant table; policy reads a session GUC set per request:

```sql
ALTER TABLE "Deal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Deal" FORCE ROW LEVEL SECURITY;          -- applies to table owner too
CREATE POLICY org_isolation ON "Deal"
  USING      ("orgId" = current_setting('app.org_id', TRUE))
  WITH CHECK ("orgId" = current_setting('app.org_id', TRUE));
```

App side — the GUC **must** be set with `set_config(..., TRUE)` (LOCAL = transaction-scoped) and the query must run **in the same transaction**, because pooled connections are reused across tenants:

```ts
await db.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, TRUE)`;
  return tx.deal.findMany();   // policy now filters by app.org_id
});
```

**Vercel serverless tradeoffs (the crux):**
- **Transaction-mode pooling (PgBouncer/Supavisor/Neon/Accelerate) forbids `SET SESSION`.** Only `SET LOCAL` / `set_config(...,TRUE)` is safe; a plain `SET` silently leaks tenant context to the next borrower of the connection ([Heroku PgBouncer best practices](https://devcenter.heroku.com/articles/best-practices-pgbouncer-configuration); [ricofritzsche.me — RLS multi-tenancy](https://ricofritzsche.me/mastering-postgresql-row-level-security-rls-for-rock-solid-multi-tenancy/)).
- **Every tenant query becomes an interactive transaction.** That doubles round-trips and is exactly the case the Prisma extension warns about; community reports show interactive-tx + extension + RLS can cause connection blocking under load ([Prisma issue #23583](https://github.com/prisma/prisma/issues/23583)). On serverless, keep the per-instance pool tiny (1–2) and front it with a transaction pooler.
- **Prisma has no first-class "set this on connection checkout" hook**, so the per-request GUC must be re-set on every transaction ([Prisma issue #4303](https://github.com/prisma/prisma/issues/4303); [Atlas — RLS in Prisma](https://atlasgo.io/guides/orms/prisma/row-level-security)).
- **Performance:** policy columns must be indexed; avoid subqueries/functions evaluated per-row. A naïve subquery policy measured ~450ms/10k rows vs ~45ms when wrapped in `IN (SELECT security_definer_fn())` — ~10× ([scottpierce.dev — optimizing RLS](https://scottpierce.dev/posts/optimizing-postgres-rls/); [bytebase — RLS footguns](https://www.bytebase.com/blog/postgres-row-level-security-footguns/)). Our `@@index([orgId, …])` already exist, so equality-on-`orgId` policies are cheap.

**Recommendation:** ship **Capability 1 first** (covers app-path leaks at low cost), then layer RLS as the hard boundary for the highest-value tables (`Deal`, `Contact`, `Company`, `Activity`). Treat RLS as the *enforcement* and the extension as the *ergonomics + GUC-setter*.

**(3) Reference evidence.** Prisma's RLS example uses `set_config('app.current_*_id', …, TRUE)` inside a tx ([Prisma RLS extension](https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security)); SET LOCAL/transaction-pooling constraint ([Heroku](https://devcenter.heroku.com/articles/best-practices-pgbouncer-configuration)); production write-up + `FORCE RLS` ([ricofritzsche.me](https://ricofritzsche.me/mastering-postgresql-row-level-security-rls-for-rock-solid-multi-tenancy/)); perf/footguns ([bytebase](https://www.bytebase.com/blog/postgres-row-level-security-footguns/), [scottpierce.dev](https://scottpierce.dev/posts/optimizing-postgres-rls/)).

**(4) Effort:** **L**. Deps: Capability 1 (GUC-setting harness), a transaction-mode pooler, migration adding policies to every tenant table, NextAuth adapter queries (they bypass `forOrg`) must use a privileged/`BYPASSRLS` role.

**(5) Tier:** **Strategic Bet.**

---

## Capability 3 — Team / sub-team model (with ownership & visibility)

**(1) What it enables.** Structure within an org: sales teams, regional pods, sub-teams. Becomes the unit for record visibility ("my team's deals"), reporting roll-ups, and assignment — the prerequisite for territories (Cap 5) and team-scoped sharing (Cap 6). Mirrors Salesforce's role hierarchy.

**(2) Design + isolation mechanism.**
Add a self-referential `Team` and a `TeamMembership`; keep org `Membership` for the org-level role.

```prisma
model Team {
  id        String  @id @default(cuid())
  orgId     String
  name      String
  parentId  String?                       // self-ref → sub-teams (closure/adjacency)
  parent    Team?   @relation("TeamTree", fields: [parentId], references: [id])
  children  Team[]  @relation("TeamTree")
  org       Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  members   TeamMembership[]
  @@index([orgId, parentId])
}

model TeamMembership {
  id       String  @id @default(cuid())
  teamId   String
  userId   String
  teamRole TeamRole @default(MEMBER)      // LEAD | MEMBER  (manager == sees subtree)
  team     Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user     User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([teamId, userId])
  @@index([userId])
}

enum TeamRole { LEAD MEMBER }
```

Add **`teamId String?`** to ownable records (`Deal`, `Contact`, `Company`, `Activity`) alongside existing `ownerId`. Ownership stays at the user; `teamId` is the visibility unit (defaults to the owner's primary team on create).

**Visibility resolution** (computed in `requireOrg`-derived context, then expressed as a `where` filter or folded into RLS):
- ADMIN/OWNER → whole org (current behavior).
- Team LEAD → own records + **entire subtree** of teams they lead (adjacency list walked once, or a `TeamClosure(ancestorId, descendantId)` table for O(1) lookups — recommended given recursive CTEs per-request are costly on serverless).
- MEMBER → own records + (configurable) same-team records.

This is **additive/most-permissive**, matching Salesforce: hierarchy grants upward automatically; nothing *removes* access ([DESelect — role hierarchy](https://deselect.com/blog/salesforce-role-hierarchy-explained-structuring-access-and-visibility/); [Salesforce — controlling access using hierarchies](https://help.salesforce.com/s/articleView?id=platform.security_controlling_access_using_hierarchies.htm)).

**Interaction with isolation:** teams are *intra-tenant* visibility and live **inside** the org boundary. RLS (Cap 2) still pins `orgId`; team visibility is a second predicate layered on top — never a replacement. Keep them separate so a team bug can't cause a cross-org leak.

**(3) Reference evidence.** Salesforce role hierarchy: managers auto-inherit subordinates' records on standard objects; the hierarchy is *separate* from the reporting org chart and is purely an access structure ([DESelect](https://deselect.com/blog/salesforce-role-hierarchy-explained-structuring-access-and-visibility/); [Salesforce platform-sharing fundamentals](https://architect.salesforce.com/fundamentals/platform-sharing-architecture)). Closure-table pattern is the standard for hierarchical access without per-request recursive CTEs.

**(4) Effort:** **M** (model + closure maintenance + visibility resolver). Deps: pairs with Cap 1/2 for the `where` injection; Cap 4 to pick a team on switch.

**(5) Tier:** **Core.**

---

## Capability 4 — Org-switching backend (validated active-org + last-active persistence)

**(1) What it enables.** First-class support for users in multiple orgs: a server-validated switch that re-mints the session with the new `activeOrgId` + role, and remembers the last-used org across devices. Today the JWT can be updated but nothing **authorizes** the target org or persists the choice.

**(2) Design + isolation mechanism.**
- **Server action** `switchOrg(orgId)`: verify a `Membership` exists for `(userId, orgId)` (authorization — currently missing!), persist `User.lastActiveOrgId` (or a `Membership.lastSeenAt`), then trigger a NextAuth session `update` so the `jwt` callback writes the new `activeOrgId`+`role`. The role **must** be re-resolved server-side from the membership, never trusted from the client (`src/lib/auth.ts:61-66` already does this — keep it).
- **JWT vs DB:** the JWT is a short-lived token re-minted on switch with the `orgId` claim; this is the documented pattern (mint fresh access token per active-org change) ([WorkOS — multi-tenant session management](https://workos.com/blog/multi-tenant-session-management); [Clerk — orgs & RBAC in Next.js](https://clerk.com/articles/organizations-and-role-based-access-control-in-nextjs)). Because role is embedded, a role change in another session is bounded by JWT TTL — keep TTL modest or re-validate role on sensitive actions.
- **Default on login:** read `User.lastActiveOrgId`, fall back to oldest membership (current logic). Harden the lazy `jwt` path to ignore an `activeOrgId` claim that no longer has a matching membership (revoked access) — fail closed to no active org.

```prisma
model User { /* … */ lastActiveOrgId String? }
```

```ts
// src/server/actions/org.ts (sketch)
export async function switchOrg(orgId: string) {
  const { userId } = await requireOrg();
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } } });
  if (!m) return fail("Not a member of that org");           // authorization gate
  await db.user.update({ where: { id: userId }, data: { lastActiveOrgId: orgId } });
  // client calls NextAuth update({ activeOrgId: orgId }) → jwt callback re-resolves role
  return ok({ orgId });
}
```

**Isolation tie-in:** `activeOrgId` is the single source feeding `requireOrg()` → `forOrg()` (Cap 1) → the RLS GUC (Cap 2). The membership re-check on switch and the "drop stale `activeOrgId`" guard are what keep a revoked user from operating in an org via a stale token.

**(3) Reference evidence.** Active-org concept + `setActive`, default null ([Better Auth — organization plugin](https://better-auth.com/docs/plugins/organization)); re-mint token with `org_id` claim on switch ([WorkOS](https://workos.com/blog/multi-tenant-session-management)); NextAuth `trigger:"update"` to refresh JWT post-login ([dev.to — NextAuth JWT update](https://dev.to/nick/nextauth-jwt-how-to-update-the-session-after-login-2e68); existing code `src/lib/auth.ts:49-51`).

**(4) Effort:** **S**. Deps: one column + one action + the stale-claim guard; UI is out of scope here.

**(5) Tier:** **Foundation.**

---

## Capability 5 — Territories (assignment-rule-driven, parallel hierarchy)

**(1) What it enables.** Geographic/segment-based ownership independent of team org structure — accounts/deals auto-assigned to a territory by rules, with a territory hierarchy granting roll-up visibility. Directly models Salesforce Enterprise Territory Management ("Sales Territories").

**(2) Design + isolation mechanism.**
A `Territory` hierarchy + a many-to-many association object (Salesforce's `ObjectTerritory2Association`). Accounts may belong to **many** territories; a deal to **one** (Salesforce constraint).

```prisma
model Territory {
  id        String  @id @default(cuid())
  orgId     String
  name      String
  parentId  String?                          // territory hierarchy
  parent    Territory?  @relation("TerrTree", fields: [parentId], references: [id])
  children  Territory[] @relation("TerrTree")
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  members   TerritoryMember[]                 // users assigned to the territory
  accounts  AccountTerritory[]
  @@index([orgId, parentId])
}
model AccountTerritory {            // == ObjectTerritory2Association
  companyId   String
  territoryId String
  byRule      Boolean @default(true)
  @@id([companyId, territoryId])
}
model TerritoryMember { territoryId String; userId String; @@id([territoryId, userId]) }
```

Add `territoryId String?` to `Deal` (single-territory). **Assignment rules** = stored predicates (e.g. `Company.industry`, region field, domain) evaluated on create/update of a `Company`, writing `AccountTerritory` rows — run in the same server action (serverless-friendly; no background worker needed at low volume). Visibility: a user sees records in their assigned territories **and child territories** (same closure-table approach as teams).

**Relationship to teams (Cap 3):** territories are an **orthogonal** access axis. Salesforce runs the territory hierarchy *in parallel* with the role hierarchy and you manage both ([Salesforce — controlling access using hierarchies](https://help.salesforce.com/s/articleView?id=platform.security_controlling_access_using_hierarchies.htm); [Salesforce Ben — territory management](https://www.salesforceben.com/territory-management-in-salesforce-10-things-you-need-to-know/)). Recommend: ship teams first, add territories only if customers need rule-based geographic assignment — it's the heaviest item and over-engineering it early is the classic trap.

**(3) Reference evidence.** ETM/Sales Territories: parent-child territory hierarchy, assignment rules auto-assign accounts/opps, accounts→many territories but opp→one (`Territory2Id`), `Territory2Model`/`ObjectTerritory2Association` objects ([Salesforce Ben](https://www.salesforceben.com/territory-management-in-salesforce-10-things-you-need-to-know/); [Calendly — territory mgmt guide](https://calendly.com/blog/territory-management-salesforce); [Trailhead — optimize ETM performance](https://trailhead.salesforce.com/content/learn/modules/advanced-territory-management/optimize-enterprise-territory-management-performance)).

**(4) Effort:** **L**. Deps: Cap 3 (closure infra, visibility resolver), Cap 1/2 (filter injection). An owner field on `Company`/`Contact` (Cap 7) is a soft prereq.

**(5) Tier:** **Strategic Bet.**

---

## Capability 6 — Record sharing across teams (owner-based + criteria-based rules)

**(1) What it enables.** Controlled exceptions to the default visibility — share a deal/contact with another team, user, or by criteria, without flattening everything to org-wide. This is Salesforce's "sharing rules" + manual share, the pressure-release valve once teams (Cap 3) make the default *restrictive*.

**(2) Design + isolation mechanism.**
A polymorphic `RecordShare` (explicit/manual shares) plus stored `SharingRule` definitions (owner-based: "Team A's deals → Team B read"; criteria-based: "deals where value > X → Region-EMEA team"). Access is the **union** of: ownership, team-hierarchy visibility (Cap 3), territory visibility (Cap 5), and shares — most-permissive wins, exactly as Salesforce composes layers.

```prisma
model RecordShare {
  id          String  @id @default(cuid())
  orgId       String
  recordType  String  // "Deal" | "Contact" | "Company"
  recordId    String
  granteeType String  // "USER" | "TEAM"
  granteeId   String
  access      String  // "READ" | "EDIT"
  @@index([orgId, recordType, recordId])
  @@index([orgId, granteeType, granteeId])
}
```

Resolving visibility now means OR-ing several predicates. With Cap 1, fold this into the extension's `where` (an `OR` array). With Cap 2 (RLS), implement as a `USING` clause calling a `SECURITY DEFINER` function that checks `orgId` + (owner OR team-subtree OR territory OR an `EXISTS` against `RecordShare`) — keep it index-backed and wrapped in `IN (SELECT fn())` to evaluate once/query, per the perf guidance ([scottpierce.dev](https://scottpierce.dev/posts/optimizing-postgres-rls/)). This is where RLS policy complexity (and cost) grows fastest — benchmark before enabling broadly.

**(3) Reference evidence.** Salesforce sharing model: OWD sets restrictive baseline; owner-based and criteria-based sharing rules *extend* access beyond the hierarchy; manual shares for one-offs; layers are additive/most-permissive ([dgt27 — sharing rules explained](https://dgt27.com/blog/salesforce-sharing-rules-explained/); [Salesforce fundamentals — platform sharing](https://architect.salesforce.com/fundamentals/platform-sharing-architecture); [O'Reilly — sharing rules & manual sharing](https://www.oreilly.com/library/view/salesforce-essentials-for/9781784398071/ch04s02.html)).

**(4) Effort:** **M–L** (model is simple; the visibility resolver / RLS policy complexity is the cost). Deps: Cap 3 (teams as grantees), Cap 1 or 2 (where injection / policy).

**(5) Tier:** **Strategic Bet.**

---

## Capability 7 — Explicit ownership model on all CRM objects + OWD setting

**(1) What it enables.** A coherent ownership story: every record has an owner, and the org chooses a default visibility ("org-wide" vs "private/team") — the equivalent of Salesforce Organization-Wide Defaults. Today only `Deal`/`Activity` have an owner and visibility is implicitly org-wide; this is the small but load-bearing piece that makes teams/territories/sharing *mean* something.

**(2) Design + isolation mechanism.**
- Add nullable `ownerId` to `Contact` and `Company` (`Deal`/`Activity` already have it). Stamp `ownerId = userId` on create (already done for `Deal`, `src/server/actions/deals.ts:39`).
- Add an org-level visibility default:

```prisma
model Organization {
  // …
  defaultRecordVisibility String @default("ORG")   // "ORG" | "TEAM" | "PRIVATE"
}
```

- `"ORG"` = current behavior (every member sees all — backward compatible). `"TEAM"`/`"PRIVATE"` flip the baseline so Cap 3/5/6 grants become meaningful. The visibility resolver (Cap 3) consults this default before applying hierarchy/share grants — mirroring how OWD is the most-restrictive floor that hierarchy and sharing rules then open up ([Salesforce fundamentals](https://architect.salesforce.com/fundamentals/platform-sharing-architecture)).

**Isolation tie-in:** ownership is *intra-org* and never substitutes for `orgId` scoping — it's a predicate layered on top of Cap 1/2. Keeping `defaultRecordVisibility = "ORG"` lets all this ship dark and be flipped per-org when teams are configured.

**(3) Reference evidence.** OWD = restrictive baseline that hierarchy + sharing rules selectively widen; private Accounts mean "see only owned or explicitly shared" ([Salesforce platform sharing architecture](https://architect.salesforce.com/fundamentals/platform-sharing-architecture); [dgt27](https://dgt27.com/blog/salesforce-sharing-rules-explained/)).

**(4) Effort:** **S** (two nullable columns + one enum + create-time stamping). Deps: none to add the fields; meaningful only with Cap 3/6.

**(5) Tier:** **Foundation.**

---

## Summary table

| # | Capability | Effort | Tier | Key deps |
|---|------------|--------|------|----------|
| 1 | Prisma client-extension auto-inject + read guard | S–M | Foundation | none |
| 2 | Postgres RLS w/ session GUC (SET LOCAL) | L | Strategic Bet | Cap 1, tx-mode pooler, privileged role for adapter |
| 3 | Team / sub-team model + visibility resolver | M | Core | Cap 1/2, closure table |
| 4 | Org-switching backend (validated + last-active) | S | Foundation | none |
| 5 | Territories (assignment rules + hierarchy) | L | Strategic Bet | Cap 3, Cap 7 |
| 6 | Cross-team record sharing (sharing rules) | M–L | Strategic Bet | Cap 3, Cap 1/2 |
| 7 | Explicit ownership on all objects + OWD default | S | Foundation | none (meaningful w/ Cap 3/6) |

---

## Top 3 picks

1. **Capability 1 — Prisma client-extension auto-inject + read guard.** Highest value-to-effort: kills the "forgot `where: { orgId }`" leak class today, needs no migration, is fully Vercel-serverless-safe, and is the harness every later layer (incl. the RLS GUC) plugs into. Ship first. **Do not stop here, though** — it shares the app's trust boundary, so pair it on the roadmap with Cap 2.
2. **Capability 4 — Org-switching backend.** Small, self-contained, and fixes a real correctness gap: there is currently **no server-side authorization** that a user belongs to the org they switch into, and no persisted "last active org." Closes a security gap and unblocks the multi-org UX. Low risk, high leverage.
3. **Capability 3 — Team/sub-team model with ownership & visibility.** The keystone for "growing platform" multi-tenancy: it's the unit territories (5), sharing (6), and meaningful ownership (7) all build on, and it directly models the proven Salesforce role-hierarchy pattern. Tackle after the two Foundation items; gate the heavier Strategic Bets (RLS hardening, territories, sharing rules) behind it and behind a real customer pull, since each is an L with non-trivial serverless/perf footguns.
