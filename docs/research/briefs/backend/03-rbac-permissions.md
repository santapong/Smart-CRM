# Smart-CRM — Fine-Grained Authorization Design Brief

**Author:** Backend/Platform Engineering
**Date:** 2026-06-20
**Scope:** Design only. No repo changes. Targets the authorization layer beyond today's 3-role hierarchy.

---

## 0. Current State (as found in repo)

- `src/lib/tenant.ts` — `requireOrg()` returns `{ userId, orgId, role }` from the NextAuth session. `role` is read from `session.user.role` (a single role per session, not per-membership lookup at call time).
- `src/lib/rbac.ts` — `RANK = { MEMBER:1, ADMIN:2, OWNER:3 }`; `hasRole()` / `requireRole()` do a numeric `>=` comparison. That is the entire authZ surface.
- `prisma/schema.prisma` — every domain row carries `orgId`. `Deal` and `Activity` already have a nullable `ownerId` (relations `DealOwner` / `ActivityOwner`); **`Company` and `Contact` have no owner column**. `Membership` is the role join table with `@@unique([userId, orgId])`.
- Server actions (`src/server/actions/*.ts`) repeat the same pattern: `requireOrg()` → `db.model.findFirst({ where: { id, orgId } })` to confirm tenancy → mutate. **No call site invokes `requireRole`** today — e.g. `deleteDeal` / `deleteCompany` are reachable by any `MEMBER`. Authorization is effectively "any member of the org can do anything within the org."
- `src/lib/db.ts` — a single global `PrismaClient` singleton. No per-request connection or session context, which matters for the RLS option below.

**Gaps to close:** (a) coarse role hierarchy only; (b) no object- or field-level permissions; (c) no record-level visibility/sharing; (d) admin checks are scattered/absent; (e) list queries are filtered only by `orgId`, so any "private record" concept must be pushed into the `where` clause.

**Design principle adopted:** keep authorization decisions in the **application/data layer using Prisma `where`-clause composition** (so list filtering and the access decision share one code path), with Postgres RLS as a defense-in-depth backstop — not as the primary policy engine. Rationale is argued in §6 (Comparison) and §7 (Recommendation).

---

## 1. Permission Model: Policy Table + Compiled Ability (roles → permissions)

**(1) What it enables.** Replaces the hardcoded `RANK` ladder with a data-driven map of *(role → permissions)*, where a permission is `(action, subject)` e.g. `delete:Deal`, `manage:Org`. Built-in roles (OWNER/ADMIN/MEMBER) become *seed rows*, not enum branches, which is the precondition for custom roles (§5) and per-object grants (§2). A request compiles the actor's grants into an in-memory **ability** object used by every check.

**(2) Design.**

Keep the `Role` enum for the built-in tiers but add a permission catalog and a join table. This is additive — existing `Membership.role` stays.

```prisma
enum PermAction { CREATE READ UPDATE DELETE MANAGE } // MANAGE = wildcard (CASL convention)

model Permission {              // catalog of (action, subject) pairs, e.g. DELETE+Deal
  id      String     @id @default(cuid())
  action  PermAction
  subject String     // "Deal" | "Contact" | "Company" | "Activity" | "Org" | "all"
  @@unique([action, subject])
}

model RolePermission {         // which built-in role grants which permission
  role         Role
  permissionId String
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)
  @@id([role, permissionId])
}
```

**Enforcement pattern.** Build the ability once per request (memoized on the request), then assert. Use `@casl/ability` to model `(action, subject, conditions, fields)` because it gives us conditions (§4) and field lists (§3) in one object, and `@casl/prisma` because its `conditions` are *Prisma `WhereInput`* — so the same rule both **decides** a single-record check and **filters** a list query (no divergence between "can I see X" and "show me all X").

```ts
// src/lib/authz/ability.ts
import { AbilityBuilder } from "@casl/ability";
import { createPrismaAbility, type PrismaQuery, type Subjects } from "@casl/prisma";

export async function buildAbility(ctx: { userId: string; orgId: string; role: Role }) {
  const { can, build } = new AbilityBuilder(createPrismaAbility);
  const grants = await getGrantsForRole(ctx.orgId, ctx.role); // from RolePermission (+custom, §5), cached
  for (const g of grants) can(g.action, g.subject);           // base CRUD-by-role
  // record-scope conditions (§4) are layered in here, e.g.:
  // can("read", "Deal", { OR: [{ ownerId: ctx.userId }, { visibility: "ORG" }, ...sharing] });
  return build();
}
```

```ts
// in a server action — replaces ad-hoc requireRole / findFirst-by-orgId
const ability = await buildAbility(ctx);
if (ability.cannot("delete", subject("Deal", deal))) return fail("Forbidden");
```

`createPrismaAbility` is the `@casl/prisma` factory whose rule `conditions` accept Prisma `WhereInput`, e.g. `can('read','Post',{ authorId: 1 })` / `cannot('read','Post',{ title:{ startsWith:'[WIP]' } })`. Requires **Prisma Client ≥ 4.16.0** (repo already targets current Prisma, so fine). [casl-prisma docs]

**(3) Reference evidence.** CASL models an ability as four properties — *action, subject, fields, conditions* — and `@casl/prisma` lets you "define CASL permissions on Prisma models using Prisma `WhereInput`" so you write conditions in Prisma's own query language instead of MongoDB syntax. [casl-prisma / npm `@casl/prisma`]. Persisting role→permission rows and compiling them at request time is the documented "Roles with persisted permissions" pattern. [CASL cookbook: Roles with persisted permissions]

**(4) Effort: S–M.** Deps: none external beyond `@casl/ability` + `@casl/prisma`. Seed migration for `Permission`/`RolePermission`. This is the substrate every other item builds on.

**(5) Tier: Foundation.**

---

## 2. Object-Level CRUD Permissions (per subject type)

**(1) What it enables.** Per-object-type CRUD independent of the role ladder — e.g. "Sales role can CRUD Deals but only READ Companies," "Read-only Auditor role." Today the absence of this is why a `MEMBER` can `deleteDeal`. This is the granular replacement for the missing `requireRole` calls.

**(2) Design.** This falls directly out of §1's `(action, subject)` permission catalog — no new tables. The work is *enforcement coverage*: a single choke-point so checks can't be forgotten (the current scattered/absent-check problem).

Introduce a thin wrapper that every action calls:

```ts
// src/lib/authz/guard.ts
export async function authorize(action: PermAction, subjectType: string, record?: object) {
  const ctx = await requireOrg();
  const ability = await buildAbility(ctx);
  const ok = record ? ability.can(action, subject(subjectType, record)) : ability.can(action, subjectType);
  if (!ok) throw new ForbiddenError(`${action} ${subjectType}`);
  return { ctx, ability };
}
```

```ts
// deals.ts deleteDeal — before: any member; after:
const { ctx } = await authorize("DELETE", "Deal");
const res = await db.deal.deleteMany({ where: { id, orgId: ctx.orgId } });
```

For **list endpoints**, derive the `where` filter from the ability so object-level perms and record-level scope (§4) compose:

```ts
import { accessibleBy } from "@casl/prisma";
const deals = await db.deal.findMany({ where: { AND: [{ orgId: ctx.orgId }, accessibleBy(ability).Deal] } });
```

`accessibleBy(ability).Deal` returns the merged `WhereInput` of all `read:Deal` rules; if the user has no read grant it yields an impossible filter (empty result), failing closed. [casl-prisma]

**(3) Reference evidence.** `accessibleBy` "to access only permitted records … rule conditions are automatically applied," and nested `include`/`select` get the same treatment. [npm `@casl/prisma`]. The "lock down by default, then grant" ordering mirrors Salesforce org-wide-defaults → selective open-up. [Salesforce Trailhead: Data Security / OWD]

**(4) Effort: M.** Deps: §1. Mostly mechanical refactor of ~8 action files to route through `authorize()` + a lint/test rule that every mutation calls it.

**(5) Tier: Foundation.**

---

## 3. Field-Level Visibility / Editability

**(1) What it enables.** Hide or freeze specific columns by role/permission — e.g. only ADMIN+ sees `Deal.value` and `Company.notes`; MEMBER can read a deal but not edit `value`. CRMs need this for comp/revenue fields.

**(2) Design.** CASL supports a `fields` array per rule: `can('read','Deal', ['title','stageId','status'])`. Two enforcement points:

- **Read (output filtering):** after fetching, project each record through the permitted-field set. Field filtering *cannot* be pushed into the SQL `WHERE` (it's column selection, not row filtering), so it happens in app code after the query — exactly how `@casl/prisma`-adjacent extensions do it ("conditional filtering of fields cannot be done within a database query by Prisma, the extension does this after querying the data"). [stalniy/casl discussion #761]

```ts
import { permittedFieldsOf } from "@casl/ability/extra";
const fields = permittedFieldsOf(ability, "read", subject("Deal", deal), { fieldsFrom: r => r.fields ?? ALL_DEAL_FIELDS });
const safe = pick(deal, fields);
```

- **Write (input filtering):** before `update`, reject or strip keys the actor lacks `update`+field on. Pair with a Zod `.pick()` per role so the action's schema itself narrows.

Optionally make it data-driven later via a `fields String[]` column on `RolePermission`; start with code-defined field maps to avoid over-engineering.

**(3) Reference evidence.** Field-level rules are first-class in CASL: `can("read","User","email",{...})`; the field is the 3rd arg, conditions the 4th. [casl-prisma; stalniy/casl #760/#761]. Field-level security as a distinct layer from record access is a core Salesforce concept (Field-Level Security vs sharing). [Salesforce: record visibility concepts]

**(4) Effort: M.** Deps: §1. Read-side projection helper + write-side schema narrowing; per-field maps for the ~4 sensitive fields to start.

**(5) Tier: Core.**

---

## 4. Ownership-Based Access (owner / org visibility)

**(1) What it enables.** Records default to "owner + admins," optionally widened to the whole org — the baseline of any sharing model. This is the cheapest record-level control and the foundation §5 extends.

**(2) Design.** Add owner + visibility to the domain models. `Deal`/`Activity` already have `ownerId`; **add `ownerId` to `Company` and `Contact`**, plus a `visibility` enum.

```prisma
enum Visibility { PRIVATE ORG }   // PRIVATE = owner + admins; ORG = all members (the OWD knob)

model Deal {
  // ...existing...
  ownerId    String?
  visibility Visibility @default(ORG)   // CRM default is collaborative; tighten per-tenant later
  @@index([orgId, ownerId])             // critical: ownership filters must hit an index
}
```

**Enforcement** is a `where` fragment produced once and reused for both single-record checks and list filters:

```ts
// src/lib/authz/scope.ts
export function recordScope(ctx, ability) {
  if (ability.can("MANAGE", "all")) return {};                 // OWNER/admin: no row restriction
  return { OR: [ { ownerId: ctx.userId }, { visibility: "ORG" } ] };  // owner OR org-visible
}
// list:  where: { AND: [{ orgId }, recordScope(ctx, ability)] }
// single: fetch by {id, orgId} then assert ownerId === userId || visibility === ORG || isAdmin
```

Because the scope is a plain Prisma `WhereInput`, it composes with `accessibleBy` (§2) and stays a single indexed query — no N+1, no post-filtering of rows.

**(3) Reference evidence.** "Owner + selectively widen" is the Salesforce OWD model: org-wide defaults set "the baseline level of access that users have to records they don't own … the access the most restricted user should have," then you "open up record access selectively." [Salesforce: managing the sharing model / OWD]. Ownership filters must be indexed: adding an index on the filtered column gives "a 26× speedup (~73ms → 2.2ms)." [dev.to: Does Postgres RLS ruin performance]

**(4) Effort: M.** Deps: §1; migration adds 2 columns × 2 tables + indexes + a backfill (`ownerId` = creator). Set `createCompany`/`createContact` to stamp `ownerId = userId` (mirrors `createDeal`).

**(5) Tier: Core.**

---

## 5. Custom Roles & Permission Sets (per-tenant)

**(1) What it enables.** Tenants define their own roles ("Sales Manager," "SDR," "Read-only Auditor") as named bundles of permissions, assignable per membership — the headline "platform" capability. Permission *sets* are additive bundles layered on top of a base role (Salesforce-style), so you grant an extra capability without cloning a whole role.

**(2) Design.** Make role a per-tenant row (not just the enum) and let memberships point at it; keep the enum for the seeded built-ins so nothing breaks.

```prisma
model CustomRole {
  id            String           @id @default(cuid())
  orgId         String
  name          String
  permissions   CustomRolePerm[]
  org           Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, name])
}
model CustomRolePerm {
  roleId       String
  permissionId String
  // optional: fieldGrants Json?  // field-level overrides (§3) per perm
  @@id([roleId, permissionId])
}
model Membership {
  // ...existing role enum stays as fallback...
  customRoleId String?   // when set, ability is compiled from CustomRole instead of/atop enum
}
// PermissionSet + MembershipPermissionSet: same shape, additive on top of the role.
```

`buildAbility` (§1) resolves grants as: **built-in role grants ∪ custom-role grants ∪ permission-set grants**, all unioned into the ability. Cache the compiled rule list per `(orgId, roleSignature)` to avoid a DB round-trip every request; invalidate on role edits. CASL's `packRules`/`toJSON` lets you store the compiled rule array as JSON and rehydrate, ~2× smaller than naive serialization. [CASL cookbook: cache-rules]

**(3) Reference evidence.** Persisted, DB-driven roles compiled into a CASL ability at runtime is the documented pattern. [CASL: Roles with persisted permissions; FullStack Labs CASL RBAC guide]. Additive permission sets on top of a base profile/role is the Salesforce model (profiles + permission sets). [Salesforce: record visibility concepts]. Packed rules for storage/transport: `ability.toJSON()` returns a compact array (~2× reduction). [CASL cookbook: cache-rules]

**(4) Effort: L.** Deps: §1, §2 (and §3 if field grants are per-role). Adds admin UI for role/permission-set management (frontend, out of this brief's scope), migrations, cache + invalidation.

**(5) Tier: Strategic Bet.**

---

## 6. Record-Sharing Rules (owner → user/team/everyone)

**(1) What it enables.** Grant access to specific records beyond ownership: share one deal with a colleague, share all of a team's records, or escalate visibility for a criteria set. This is the Salesforce "sharing rules + manual share" layer and the most powerful record-level control.

**(2) Design — two complementary mechanisms:**

**(a) Manual/explicit share (Salesforce `__Share`-style grant table).** A denormalized grant row per (record, grantee, access level). Generic via `(subjectType, subjectId)`:

```prisma
enum AccessLevel { READ EDIT }
model RecordShare {
  id          String      @id @default(cuid())
  orgId       String
  subjectType String      // "Deal" | "Contact" | ...
  subjectId   String
  granteeType String      // "USER" | "TEAM"
  granteeId   String      // userId or teamId
  access      AccessLevel
  @@index([orgId, subjectType, granteeId])  // lookup grants for an actor
  @@index([subjectType, subjectId])         // lookup who a record is shared with
}
model Team        { id String @id @default(cuid()); orgId String; name String }
model TeamMember  { teamId String; userId String; @@id([teamId, userId]) }
```

**Enforcement (list filter)** — union ownership (§4) with shared IDs. To keep it one indexed query, resolve the actor's shared IDs for the subject type first, then `IN`-filter:

```ts
const sharedIds = await db.recordShare.findMany({
  where: { orgId, subjectType: "Deal", access: { in: ["READ","EDIT"] },
    OR: [ { granteeType:"USER", granteeId: userId },
          { granteeType:"TEAM", granteeId: { in: myTeamIds } } ] },
  select: { subjectId: true },
});
const where = { AND: [ { orgId },
  { OR: [ { ownerId: userId }, { visibility:"ORG" }, { id: { in: sharedIds.map(s=>s.subjectId) } } ] } ] };
```

This is the denormalized-grant approach Salesforce uses: "Object Sharing tables store access grants to individuals and groups … Group Maintenance tables store the list of users/groups that belong to each group," and grants are "established in advance when you create/change membership" rather than computed per request. [Salesforce: sharing architecture; "Record Access Under the Hood"]. `TeamMember` is our Group-Maintenance table; precompute `myTeamIds` once per request.

**(b) Criteria-based sharing rule (rule, not per-row).** Store a predicate and an audience; compile it into the ability's conditions at `buildAbility` time:

```prisma
model SharingRule {            // "deals where stage=Negotiation → shared READ with Team X"
  id          String  @id @default(cuid())
  orgId       String
  subjectType String
  criteria    Json    // a Prisma WhereInput fragment, validated server-side
  granteeType String  // USER | TEAM | EVERYONE
  granteeId   String?
  access      AccessLevel
}
```

At compile time, for each rule whose audience includes the actor, OR its `criteria` into the read/edit conditions. **Guardrail:** `criteria` is operator-allow-listed and validated (never raw user SQL) to avoid injection — the documented RLS/policy pitfall when predicates depend on user input. [permit.io: Postgres RLS pitfalls].

**(3) Reference evidence.** Salesforce sharing rule = "which records to share, with which users, with what kind of access," used to "make automatic exceptions to your org-wide sharing settings." [Salesforce Ben: Sharing Rules guide; Trailhead: Define Sharing Rules]. Four grant types (explicit, group-membership, inherited, implicit) and the denormalized pre-computation. [Salesforce: sharing architecture]. ReBAC engines (OpenFGA) model this as tuples and answer "what can this user access" via `ListObjects`, which is "fundamentally a graph traversal over relationship tuples" — informative, but see §7 for why we keep it in Postgres. [OpenFGA: relationship queries / ListObjects].

**(4) Effort: L.** Deps: §1, §4; add `Team`/`TeamMember` + share tables + rule compiler + cache invalidation on share/team changes. Criteria validation is the risk area.

**(5) Tier: Strategic Bet.**

---

## 7. Postgres RLS as Defense-in-Depth Backstop

**(1) What it enables.** A database-enforced safety net so a forgotten `where: { orgId }` (the current single point of failure across every action) cannot leak cross-tenant data, regardless of app bugs. Primary policy stays in the app (§1–§6); RLS guarantees the tenant boundary.

**(2) Design.** Enable RLS on tenant tables with a policy keyed off a per-transaction session variable, and set that variable via a Prisma client extension before each query.

```sql
ALTER TABLE "Deal" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Deal"
  USING ("orgId" = current_setting('app.org_id', true));   -- 'true' = don't error if unset → fails closed (no rows)
```

```ts
// src/lib/db.ts — extend the singleton
export const db = base.$extends({
  query: { $allModels: { async $allOperations({ args, query }) {
    const orgId = getRequestOrgId();                 // from AsyncLocalStorage set in requireOrg()
    return base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`; // true = tx-scoped
      return query(args);
    });
  }}},
});
```

**Critical caveats (all sourced):**
- **Index every column used in `USING`/`WITH CHECK`.** Unindexed → seq scan per query; indexed `orgId` ≈ **26× faster** (73ms→2.2ms). We already index `orgId` on most tables; add the ownership indexes from §4. [dev.to RLS perf; Supabase RLS best practices]
- **Avoid VOLATILE function calls in policies.** They block index use and re-evaluate per row; wrap with `(SELECT current_setting(...))` so it's evaluated once per query. [Supabase RLS performance; scottpierce.dev]
- **`set_config(..., true)` = transaction-local** so a pooled connection can't leak context to the next request; the `true` second arg on `current_setting` returns NULL instead of erroring when unset, which makes the policy **fail closed**. [permit.io RLS guide]
- **Connection pooling:** because Prisma reuses connections, the set-config MUST be inside the same transaction as the query (above), or use a dedicated non-pooled connection for RLS sessions. [Medium: RLS with Prisma]
- Policy overhead itself is small on big scans ("1.6ms out of 73.3ms"); the cost that matters is missing indexes, not RLS per se. [dev.to RLS perf]

Start RLS at the **org boundary only** (highest blast-radius bug). Pushing per-record sharing (§6) into RLS is possible but couples policy to SQL and is hard to keep in sync with the app's compiled ability — keep record-level logic in the app.

**(3) Reference evidence.** Standard pattern: `CREATE POLICY ... USING (tenant_id = current_setting('app.tenant_id')::uuid)` with `set_config('app.tenant_id', ...)` per request, wired through `prisma.$extends()` in a context-setting transaction. [Medium: Securing Multi-Tenant with RLS + Prisma; permit.io]. Risk if the var is unset: "queries might either return no data or, worse, expose all data" — hence fail-closed `true` + NOT NULL discipline. [search synthesis; permit.io].

**(4) Effort: M.** Deps: per-request context via `AsyncLocalStorage` (small refactor of `requireOrg`), migration to enable RLS + policies, and validating Prisma pooling behavior on Vercel/Postgres. Risk: connection-pool/transaction interplay.

**(5) Tier: Core** (do after §1–§4; it is a backstop, not the policy engine).

---

## 8. Comparison of Approaches (decision rationale)

| Approach | Model | List filtering | Where authz data lives | Fit for this stack |
|---|---|---|---|---|
| **CASL (+@casl/prisma)** | RBAC/ABAC in app; ability = action+subject+fields+conditions | **Native** — `accessibleBy(ability).Model` emits a Prisma `WhereInput`; same rule decides & filters | Your Postgres (conditions are Prisma queries) | **Best fit.** TS-native, no new infra, conditions are Prisma `WhereInput`, field-level built in. ≥ Prisma 4.16. [casl-prisma] |
| **Oso** | Policy-as-code (Polar); "data filtering" generates DB filters from policy | Yes — "generates filters from your authorization policy so your DB returns only authorized results"; uses app DB **in place**, "don't have to synchronize anything to an external store" | Your DB (Oso Cloud) or library | Strong on list filtering without a replica; adds a policy language + (for Cloud) a service dependency. [osohq: OpenFGA alternatives] |
| **OpenFGA / Zanzibar** | ReBAC tuples; `Check` + `ListObjects` | `ListObjects` = "graph traversal over relationship tuples"; tail-latency-sensitive on the hot path | **Separate datastore** — "requires you to replicate data to a secondary data store … extra operational overhead" | Overkill now; great if relationships get deep (nested teams/orgs). Operational + sync cost not justified yet. [openfga: ListObjects; osohq] |
| **Salesforce sharing model** | OWD → role hierarchy → sharing rules → manual share; denormalized grant + group-maintenance tables | Pre-computed grant rows queried at access time | Internal denormalized tables | A **design template**, not a library. We borrow OWD-then-widen (§4), `__Share` grant table (§6), group/team maintenance. [Salesforce architecture; under-the-hood PDF] |
| **Postgres RLS** | DB-enforced predicates via `current_setting` | Implicit on every query | The database | **Backstop, not primary** (§7). Brittle for per-record sharing; excellent as a tenant-isolation guarantee. Needs indexes + tx-scoped set_config. [Supabase; permit.io; dev.to] |

**Why not OpenFGA/Oso-Cloud as primary:** both shine for deep relationship graphs, but they move authorization data out of (OpenFGA) or alongside (Oso) Postgres and add an external dependency + consistency model (Zanzibar zookies, `HIGHER_CONSISTENCY` "significant impact on performance"). [openfga: consistency]. Smart-CRM's relationships are shallow (org → owner → team), so a Prisma-`WhereInput` ability gives the same list-filtering benefit with zero new infra and one query path. Revisit OpenFGA if cross-org hierarchies or deeply nested team trees emerge (§"Strategic Bet" escape hatch).

---

## 9. Recommendation (pragmatic path for Next.js 15 + Prisma + Postgres + NextAuth v5 on Vercel)

Adopt **CASL `@casl/ability` + `@casl/prisma` as the single policy engine**, with permissions stored in Postgres (§1), enforced through one `authorize()` choke-point (§2), and **Postgres RLS as a tenant-isolation backstop** (§7). This keeps every authorization decision expressible as a Prisma `WhereInput`, so the *same rule* gates a single record and filters a list — directly fixing today's "filter is only `orgId`" and "checks are scattered/absent" gaps without adding external services to the Vercel deployment. Layer ownership/visibility (§4) before sharing rules (§6); make custom roles (§5) the platform headline once the substrate is proven.

---

## Top 3 picks

1. **Policy Table + Compiled CASL Ability (§1, Foundation, S–M)** — the data-driven substrate that turns roles into permissions and makes every later capability possible; conditions double as Prisma list filters via `accessibleBy`.
2. **Ownership + Org Visibility record scope (§4, Core, M)** — cheapest record-level control; add `ownerId`/`visibility` (+indexes) to Company/Contact and reuse one indexed `where` fragment for checks and lists.
3. **Object-Level CRUD via a single `authorize()` choke-point (§2, Foundation, M)** — closes the current hole where any MEMBER can delete, and guarantees no mutation ships without a check.

---

### Sources

- CASL `@casl/prisma` — npm package & docs (abilities = action/subject/fields/conditions; `createPrismaAbility`; `accessibleBy`; Prisma `WhereInput` conditions; ≥ Prisma 4.16): https://www.npmjs.com/package/@casl/prisma · https://casl.js.org/v6/en/package/casl-prisma
- CASL field-level restriction discussions (fields arg; post-query field filtering): https://github.com/stalniy/casl/discussions/761 · https://github.com/stalniy/casl/issues/760
- CASL cookbook — Roles with persisted permissions; cache/pack rules (`toJSON`/`packRules`, ~2× smaller): https://casl.js.org/v6/en/cookbook/roles-with-persisted-permissions/ · https://casl.js.org/v4/en/cookbook/cache-rules/
- FullStack Labs — CASL RBAC in JS: https://www.fullstack.com/labs/resources/blog/role-based-user-authorization-in-javascript-with-casl
- Oso — OpenFGA alternatives (data filtering generates DB filters; uses app DB in place vs replicated store): https://www.osohq.com/learn/openfga-alternatives
- OpenFGA — Relationship queries / ListObjects (graph traversal; performance): https://openfga.dev/docs/interacting/relationship-queries · ListObjects algorithm: https://auth0.com/blog/openfga-improved-listobjects-algorithm/ · Consistency modes: https://openfga.dev/docs/interacting/consistency · FGA concepts: https://openfga.dev/docs/fga
- Salesforce — Managing the sharing model / OWD: https://help.salesforce.com/s/articleView?id=platform.managing_the_sharing_model.htm · Data Security (Trailhead): https://trailhead.salesforce.com/content/learn/modules/data_security/data_security_records · Sharing Rules guide (Salesforce Ben): https://www.salesforceben.com/tips-for-planning-and-creating-salesforce-sharing-rules/ · Platform sharing architecture (grant types, sharing/group-maintenance tables): https://architect.salesforce.com/fundamentals/platform-sharing-architecture · Record Access Under the Hood (PDF): https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf
- Postgres RLS + Prisma (set_config/current_setting, $extends transaction): https://medium.com/@francolabuschagne90/securing-multi-tenant-applications-using-row-level-security-in-postgresql-with-prisma-orm-4237f4d4bd35
- Postgres RLS performance (index = 26× speedup; policy overhead small): https://dev.to/ashwin_sridhar_koto7/does-postgres-rls-actually-ruin-performance-lets-look-at-the-data-24jf · Supabase RLS best practices: https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv · scottpierce.dev RLS optimization: https://scottpierce.dev/posts/optimizing-postgres-rls/
- Postgres RLS pitfalls / fine-grained permissions (injection via user-supplied predicates; fail-closed): https://www.permit.io/blog/postgres-rls-implementation-guide · https://www.permit.io/blog/implementing-fine-grained-postgres-permissions-for-multi-tenant-applications
- Prisma Client extensions (query interception): https://www.prisma.io/docs/orm/prisma-client/client-extensions/query
