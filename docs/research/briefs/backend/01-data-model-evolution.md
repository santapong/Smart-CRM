# Smart-CRM — Backend Design Brief 01: Data-Model Evolution & Extensibility

**Author:** Senior backend/platform engineer
**Date:** 2026-06-20
**Scope:** Custom fields engine, custom objects/modules, polymorphic associations, JSONB-vs-EAV decision.
**Status:** RESEARCH / DESIGN ONLY — no repo changes. Grounded in the current repo; competitor and Postgres internals cited inline.

---

## 0. Context & constraints (grounded in the repo)

What exists today (`prisma/schema.prisma`, `src/lib/*`, `src/server/actions/*`):

- **Fixed columns only.** `Contact`, `Company`, `Deal`, `Activity` are hand-modeled tables. There is no per-org extension point — the KNOWN GAP this brief addresses.
- **Strong tenant + RBAC spine to reuse.** Every business row has `orgId`; `requireOrg()` (`src/lib/tenant.ts`) returns `{ userId, orgId, role }`; `requireRole()` (`src/lib/rbac.ts`) ranks `MEMBER<ADMIN<OWNER`. Custom-field admin operations should require `ADMIN`; value writes inherit the entity's existing role checks.
- **Server-action + Zod + ActionResult pattern.** Actions `safeParse` input, then `fail("Invalid input", error.flatten().fieldErrors)` or `ok(data)` (`src/lib/action-result.ts`, `src/server/actions/contacts.ts`). Our custom-field validation must produce the **same `fieldErrors` shape** so the existing form/error UI keeps working — but the schema is now built **dynamically at runtime** from field definitions, not statically authored.
- **Prisma query-builder filtering, not raw SQL.** Search (`src/server/actions/search.ts`) uses `contains` / `mode: "insensitive"`. This is the ergonomic baseline; any approach that forces us off Prisma's builder for *every* query is a real cost.
- **Prisma 5.22, Postgres 16, Vercel serverless, no Redis/jobs/search engine** (`package.json`, INFRA REALITY). Implications: (a) no background worker to rebuild indexes or backfill async — schema/index changes must be safe and fast or chunked across requests; (b) connection-count pressure means we avoid per-request `CREATE INDEX`; (c) no external search engine, so filtering/sorting on custom fields must be served by Postgres itself.

These four facts drive the central recommendation below.

---

## 1. The core decision: JSONB vs EAV vs hybrid

This decision underpins capabilities C1–C3, so it is resolved first.

### Option A — EAV (entity-attribute-value)
One `CustomFieldValue` row per (record, field). Salesforce's physical model is a constrained EAV: custom data lives in a wide `MT_Data` table of generic flex columns described by a metadata dictionary (the UDD), and indexed values are *synchronously copied* into a pivot table `MT_Indexes` holding strongly-typed `StringValue` / `NumValue` / `DateValue` columns, with `MT_Unique_Indexes` enforcing uniqueness ([Salesforce Architects — Platform Multitenant Architecture](https://architect.salesforce.com/fundamentals/platform-multitenant-architecture); [O'Reilly — The Force.com Multitenant Architecture, "The Indexes Pivot Table"](https://www.oreilly.com/library/view/the-forcecom-multitenant/30000LTI00089/30000LTI00089_ch08lev1sec5.html); [Salesforce Engineering — Metadata: Software The Way You Want It](https://engineering.salesforce.com/metadata-software-the-way-you-want-it-2367b179558d/)).

- **Pros:** granular per-attribute row locking (concurrent writes to different fields don't contend); trivial per-value typed indexing; clean uniqueness; sparse storage.
- **Cons:** every record read is an N-row join/pivot; querying M fields needs M self-joins; **catastrophic without indexes** — benchmarked >50,000× slower than JSONB on unindexed lookups ([coussej — Replacing EAV with JSONB in PostgreSQL](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/)). Heavy in Prisma: a value table + manual reshaping on every read/write. Salesforce only makes it work with a bespoke kernel we do not have.

### Option B — JSONB column per entity
Add `customFields Json` to each entity; store `{ fieldKey: value }`.

- **Pros:** one row per record (reads stay single-row); native to Prisma's `Json` type; sparse; adding a field is **metadata-only — no DDL, no migration** (decisive on serverless). GIN containment is fast: with a GIN index, `@>` equality was ~15,000× faster than EAV and ~25,000× faster than the `->>` operator in the same benchmark ([coussej](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/); [Crunchy Data — Indexing JSONB in Postgres](https://www.crunchydata.com/blog/indexing-jsonb-in-postgres)).
- **Cons:**
  - **Range/sort needs typed B-tree expression indexes, not GIN.** GIN `jsonb_ops` serves `@>`, `?`, `?|`, `?&`, `@?`, `@@`; `jsonb_path_ops` serves `@>`, `@?`, `@@` with a smaller, faster index — *neither serves `>`/`<`/`ORDER BY`* on a key. Range/sort requires `CREATE INDEX ... ((data->>'k')::numeric)`, and the query's WHERE expression must **match the index expression exactly** (`::numeric` vs `::float` won't match) ([PostgreSQL docs — JSON Types & GIN opclasses](https://www.postgresql.org/docs/current/datatype-json.html); [pganalyze — Understanding Postgres GIN Indexes](https://pganalyze.com/blog/gin-index); the cast/expression-match rule and multi-column expression indexes per [TigerData](https://www.tigerdata.com/learn/how-to-index-json-columns-in-postgresql)).
  - **Prisma JSON filtering is limited on Postgres.** Supported modes are `path` + `array_contains` only (`string_contains` is MySQL-only); `path` must be an array (Prisma 5); **you cannot filter on object-key values inside arrays**; partial-text and complex predicates need raw SQL ([Prisma docs — Working with Json fields](https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields); [prisma/prisma#9325](https://github.com/prisma/prisma/issues/9325)).
  - **Whole-column write lock.** Updating one key rewrites the whole JSONB value → heavier row locks than EAV under high concurrent writes ([coussej](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/)). Acceptable for "small teams" write volumes.
  - No DB-level typing/uniqueness — must be enforced in the app layer.

### Option C — Hybrid: JSONB storage + metadata registry + selective typed/promoted indexes (RECOMMENDED)
Store values in a per-entity `customFields Json` column (Option B's ergonomics and zero-DDL writes). Govern them with a `CustomFieldDefinition` metadata registry (Salesforce's UDD idea; Attio's typed-attribute idea). Index only what each org actually filters/sorts on, using the right tool per access pattern:

- **Equality / "has value" / multi-select containment** → one **GIN `jsonb_path_ops`** index per entity on the JSONB column (smallest, fastest for `@>`).
- **Range + sort on a hot field** (e.g. a numeric "ARR", a date "renewal") → a **B-tree expression index** on the cast key, created lazily when an admin marks a field *filterable/sortable*. This is our analogue of Salesforce's typed `MT_Indexes` pivot — typed access without a separate pivot table.
- **High-value fields can be "promoted" to real columns** later (capability C7) when an org outgrows JSONB for a specific field.

This mirrors the modern consensus — JSONB replaces EAV for flexible custom data, with EAV-grade typed indexing recovered selectively via expression indexes — while staying inside Prisma for the common path and dropping to `$queryRaw` only for range/sort. Net: **Hybrid (Option C).**

> **Why not pure EAV:** no kernel to amortize the join cost, terrible Prisma ergonomics, and JSONB matches it on indexed reads while crushing it on unindexed reads. **Why not pure JSONB:** range/sort and typing are weak; the metadata registry + selective expression indexes fix exactly those gaps.

---

## 2. Capabilities

Each: (1) name + product feature, (2) design + Prisma sketch + filtering/validation, (3) evidence, (4) Effort + deps, (5) tier.

---

### C1 — Custom Field Definitions (the metadata registry)
**(1) Product feature:** Org admins add typed custom fields ("Lead Source", "Contract Value", "Renewal Date") to Contact/Company/Deal from a settings UI — no engineering, no deploy. This is the foundation every other capability builds on.

**(2) Design.** A single registry table describes every custom field. Storage lives in a `customFields Json` column on each target entity (added in C2).

```prisma
enum CustomEntity { CONTACT COMPANY DEAL }      // extended by C5 for custom objects

enum FieldType {
  TEXT TEXTAREA NUMBER CURRENCY DATE DATETIME
  BOOLEAN SELECT MULTISELECT URL EMAIL PHONE
  RECORD_REFERENCE        // C4: link to another record
}

model CustomFieldDefinition {
  id          String       @id @default(cuid())
  orgId       String
  entity      CustomEntity                       // which built-in/custom object it extends
  key         String                             // stable JSON key, e.g. "lead_source" (immutable)
  label       String                             // display label (editable)
  type        FieldType
  required    Boolean      @default(false)
  unique      Boolean      @default(false)       // app-enforced uniqueness (C6)
  filterable  Boolean      @default(false)       // gate expression-index creation
  sortable    Boolean      @default(false)
  config      Json?                              // {options:[...]} | {currency:"USD"} | {refEntity,...}
  order       Int          @default(0)
  archived    Boolean      @default(false)       // soft-delete: hide without dropping data
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, entity, key])                 // no duplicate keys per entity per org
  @@index([orgId, entity])
}
```

**Type immutability:** like HubSpot, the `type` is fixed at creation; changing type means new field + migrate + archive old ([HubSpot — Properties API](https://developers.hubspot.com/docs/guides/api/crm/properties); knowledge base on the data model builder). `key` is immutable; `label`, `order`, `required`, `filterable`, `sortable`, options can change.

**Validation engine (reuses the repo's Zod + ActionResult pattern).** A pure function compiles definitions → a Zod schema at request time, so dynamic fields produce the *same* `fieldErrors` shape the UI already consumes (`src/lib/action-result.ts`):

```ts
// src/lib/custom-fields/schema.ts (sketch)
function zodForField(def: CustomFieldDefinition): z.ZodTypeAny {
  switch (def.type) {
    case "NUMBER":
    case "CURRENCY":   return z.coerce.number();
    case "DATE":
    case "DATETIME":   return z.coerce.date();
    case "BOOLEAN":    return z.coerce.boolean();
    case "EMAIL":      return z.string().email();
    case "URL":        return z.string().url();
    case "SELECT":     return z.enum(def.config.options as [string, ...string[]]);
    case "MULTISELECT":return z.array(z.enum(def.config.options as [string, ...string[]]));
    default:           return z.string().max(10_000);
  }
}
export function buildCustomFieldsSchema(defs: CustomFieldDefinition[]) {
  const shape = Object.fromEntries(defs.filter(d => !d.archived).map(d => {
    const base = zodForField(d);
    return [d.key, d.required ? base : base.optional().nullable()];
  }));
  return z.object(shape).strip();  // unknown keys dropped → can't smuggle unregistered fields
}
```

Entity actions compose this with the static schema: `staticSchema.safeParse(input)` for known columns + `buildCustomFieldsSchema(defs).safeParse(input.customFields)`; merge `fieldErrors`. `requireRole(role, "ADMIN")` gates create/edit/archive of definitions.

**(3) Evidence.** Typed attribute registry with per-type config and `is_required`/`is_unique`/`is_multiselect` flags is exactly Attio's model ([Attio — Create and manage attributes](https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes); [Attio — attribute types](https://docs.attio.com/docs/attribute-types/attribute-types)). Metadata-as-source-of-truth is Salesforce's UDD ([Salesforce Engineering](https://engineering.salesforce.com/metadata-software-the-way-you-want-it-2367b179558d/)). Permanent field type = HubSpot ([HubSpot Properties API](https://developers.hubspot.com/docs/guides/api/crm/properties)).

**(4) Effort:** **M.** Deps: none (pure new table + lib). Prereq for everything below.
**(5) Tier:** **Foundation.**

---

### C2 — JSONB value storage on built-in entities
**(1) Product feature:** Custom-field values actually persist on Contacts/Companies/Deals and round-trip through the existing detail/edit screens.

**(2) Design.** Add one column per target entity:

```prisma
model Contact { /* ...existing... */ customFields Json @default("{}") }
model Company { /* ...existing... */ customFields Json @default("{}") }
model Deal    { /* ...existing... */ customFields Json @default("{}") }
```

`@default("{}")` so reads never hit `null`. Reads: return `record.customFields` merged with definitions for rendering. Writes: validate via C1's schema, then `data: { customFields: validatedObject }`. Because keys live in one column, **adding/removing a field is metadata-only — no `ALTER TABLE`, no migration, no Prisma client regen** — the property that makes this viable on Vercel serverless. Use `jsonb` (Prisma maps `Json` → `jsonb` on Postgres), required because Prisma's `array_contains` errors on the `json` type ([prisma/prisma#8977](https://github.com/prisma/prisma/issues/8977)).

**Filtering (the nuanced part):**
- Equality / has-value / multi-select-contains → Prisma builder: `where: { customFields: { path: ["lead_source"], equals: "Inbound" } }` and `{ path: ["tags"], array_contains: ["vip"] }`. Backed by the GIN index in C3.
- Range / sort → **raw SQL** via `db.$queryRaw`, matching a B-tree expression index exactly (C3), because Prisma JSON filters don't express range on Postgres and `string_contains` is MySQL-only ([Prisma — Working with Json fields](https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields)).

**(3) Evidence.** "Objects are tables, properties are columns" is the user-facing abstraction (HubSpot) implemented over flexible storage ([HubSpot data architecture guide](https://www.hyphadev.io/blog/complete-guide-hubspot-crm-data-architecture)). JSONB-replaces-EAV with single-row reads is the documented pattern ([coussej](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/)).

**(4) Effort:** **S** (three columns + read/write glue). Deps: **C1**.
**(5) Tier:** **Foundation.**

---

### C3 — Custom-field indexing strategy (GIN + lazy typed expression indexes)
**(1) Product feature:** List views stay fast when orgs filter/sort by custom fields ("Deals where Contract Value > 50k, sorted by Renewal Date") instead of scanning every row.

**(2) Design.** Two layers, applied per access pattern (this is Option C made concrete):

```sql
-- Layer 1: one GIN per entity for equality / containment / has-key (created once, in a migration).
CREATE INDEX contact_customfields_gin ON "Contact" USING GIN (("customFields") jsonb_path_ops);

-- Layer 2: lazy B-tree expression index, created only when an admin flags a field
-- filterable/sortable. NUMBER/CURRENCY:
CREATE INDEX CONCURRENTLY contact_cf_arr_num
  ON "Contact" ((("customFields"->>'arr')::numeric)) WHERE "orgId" IS NOT NULL;
-- DATE/DATETIME:
CREATE INDEX CONCURRENTLY deal_cf_renewal_date
  ON "Deal" ((("customFields"->>'renewal_date')::timestamptz));
```

- **`jsonb_path_ops`** chosen over default `jsonb_ops`: smaller, faster index, and we only need `@>` containment — we never need the key-exists operators that `jsonb_path_ops` drops ([PostgreSQL — built-in GIN opclasses](https://www.postgresql.org/docs/16/gin-builtin-opclasses.html); [pganalyze](https://pganalyze.com/blog/gin-index)).
- **Range/sort → typed B-tree expression index.** GIN cannot serve `>`/`<`/`ORDER BY`; the expression index can, and the app must emit the **exact same cast expression** in WHERE/ORDER BY or the planner won't use it ([TigerData — How to Index JSONB Columns](https://www.tigerdata.com/learn/how-to-index-json-columns-in-postgresql)). Centralize expression generation so query and index always agree.
- **Lazy creation, not blanket.** Don't index every key (index bloat + write cost). Create only when `filterable`/`sortable` is set — the "index what's queried" guidance ([Crunchy Data](https://www.crunchydata.com/blog/indexing-jsonb-in-postgres)). Serverless caveat: `CREATE INDEX CONCURRENTLY` can't run in Prisma's transaction and there's no job runner — execute it out-of-band (admin-triggered action issuing a single `$executeRawUnsafe` with a validated identifier, or a checked-in migration). For small-team data volumes, a brief non-concurrent build is also acceptable.

This is the JSONB-native equivalent of Salesforce copying indexed values into typed `MT_Indexes` columns — same intent (typed indexed access over flexible storage), one fewer table ([O'Reilly — Indexes Pivot Table](https://www.oreilly.com/library/view/the-forcecom-multitenant/30000LTI00089/30000LTI00089_ch08lev1sec5.html)).

**(3) Evidence.** Operator-class tradeoffs and the GIN-can't-do-range limitation: [PostgreSQL docs](https://www.postgresql.org/docs/current/datatype-json.html), [pganalyze](https://pganalyze.com/blog/gin-index). Expression-index cast + exact-match rule + multi-column expression indexes: [TigerData](https://www.tigerdata.com/learn/how-to-index-json-columns-in-postgresql). Magnitude of GIN `@>` speedup: [coussej](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/).

**(4) Effort:** **M** (GIN migration is trivial; the lazy expression-index manager + matched query generation is the work). Deps: **C2**.
**(5) Tier:** **Core.**

---

### C4 — Record-reference (relationship) custom fields
**(1) Product feature:** A custom field that links records — "Referred By → Contact", "Primary Vendor → Company" — beyond the built-in FKs, including links to custom objects (C5).

**(2) Design.** A `RECORD_REFERENCE` field whose `config` names the target: `{ "refEntity": "COMPANY", "refObjectId": null }` (built-in) or `{ "refEntity": "CUSTOM", "refObjectId": "<CustomObject.id>" }`. The value stored in JSONB is the target record id (or an array for to-many). Because JSONB can't carry a real FK, integrity is **app-enforced**: on write, verify the referenced id exists *and shares `orgId`* (a query the existing `requireOrg` scoping makes natural); on display, resolve in a batched lookup. For heavily traversed links, prefer promoting to a real relation (C7) or a typed join table.

For symmetric many-to-many that needs its own attributes/integrity, use a **join table per relationship**, not a generic `(ownerType,ownerId)` polymorphic pair — the latter forbids DB FKs, wastes space on type strings, and defeats index use ([GitLab — Polymorphic Associations](https://docs.gitlab.com/development/database/polymorphic_associations.html); [Hashrocket — Modeling Polymorphic Associations](https://hashrocket.com/blog/posts/modeling-polymorphic-associations-in-a-relational-database)). See C8 for the controlled exception.

**Filtering:** "deals referencing company X" → `where: { customFields: { path: ["primary_vendor"], equals: "<companyId>" } }`, served by the C3 GIN index.

**(3) Evidence.** Typed `record_reference` attributes with target config, and relationship attributes connecting objects, are Attio's model ([Attio — attribute types](https://docs.attio.com/docs/attribute-types/attribute-types); [Attio — data model](https://attio.com/help/reference/attio-101/attios-data-model/understanding-attio-data-model)). HubSpot models associations as foreign-key-like links across objects ([HubSpot data architecture](https://www.hyphadev.io/blog/complete-guide-hubspot-crm-data-architecture)).

**(4) Effort:** **M** (write-time validation + batched resolution + UI picker). Deps: **C1, C2**; richer with **C5**.
**(5) Tier:** **Core.**

---

### C5 — Custom objects / modules
**(1) Product feature:** Orgs define entirely new record types ("Projects", "Subscriptions", "Properties") with their own custom fields — not just extra fields on built-ins.

**(2) Design (recommended: shared generic `CustomRecord` table, JSONB-backed).** Avoid per-object physical tables: serverless can't safely run per-tenant DDL on demand, and unbounded table creation is an ops hazard. Instead, a metadata table defines the object and one shared table holds all custom records, scoped by `orgId` + `objectId`:

```prisma
model CustomObject {
  id        String   @id @default(cuid())
  orgId     String
  key       String                              // "project" (immutable, used in routes/api)
  labelSingular String
  labelPlural   String
  icon      String?
  createdAt DateTime @default(now())
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  records   CustomRecord[]
  @@unique([orgId, key])
}

model CustomRecord {
  id           String   @id @default(cuid())
  orgId        String
  objectId     String
  displayName  String                           // denormalized "primary" field for lists/search
  customFields Json     @default("{}")          // all fields, same engine as C1–C3
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  object       CustomObject @relation(fields: [objectId], references: [id], onDelete: Cascade)
  org          Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@index([orgId, objectId])
  @@index([orgId, objectId, displayName])
}
```

`CustomFieldDefinition.entity` extends to reference a `CustomObject` (add a nullable `customObjectId` and treat `entity=CUSTOM`). The same validation engine (C1), JSONB storage (C2), and indexing (C3) apply unchanged — the whole point of the hybrid model is that custom objects are "free" once the engine exists. GIN index on `CustomRecord.customFields` once.

**Limits as product guardrails** (prevent the HubSpot-style sprawl that "no guardrails on creation" causes): cap custom objects and unique-identifier fields per org. HubSpot caps at 10 custom objects and ≤10 unique-identifier properties per portal ([HubSpot — custom object limits](https://www.smartbugmedia.com/blog/hubspot-custom-object); [HubSpot — create custom objects KB](https://knowledge.hubspot.com/object-settings/create-custom-objects)).

**(3) Evidence.** Objects = record types holding their own attributes/records, with standard + custom objects side by side, is Attio's and HubSpot's core model ([Attio — Create and manage custom objects](https://attio.com/help/reference/managing-your-data/objects/create-and-manage-custom-objects); [HubSpot — use custom objects](https://knowledge.hubspot.com/crm-setup/use-custom-objects)). Salesforce represents custom objects as metadata mapped onto generic physical storage rather than new physical tables per object ([Salesforce Engineering](https://engineering.salesforce.com/metadata-software-the-way-you-want-it-2367b179558d/)) — the precedent for our shared-table choice.

**(4) Effort:** **L** (new generic CRUD, dynamic routes/forms, search integration, list views). Deps: **C1, C2, C3**; pairs with **C4**.
**(5) Tier:** **Strategic Bet.**

---

### C6 — App-enforced uniqueness & required validation for custom fields
**(1) Product feature:** "Employee ID must be unique", "Lead Source is required" — data-quality rules HubSpot/Salesforce/Attio all expose.

**(2) Design.** `required` is handled by C1's Zod compilation. `unique` can't be a Postgres `UNIQUE` constraint on a JSONB key without a **partial unique expression index**, so support it in two tiers:
- **DB-backed (preferred for hot unique fields):**
  `CREATE UNIQUE INDEX CONCURRENTLY contact_cf_empid_uniq ON "Contact" (("customFields"->>'employee_id')) WHERE "customFields" ? 'employee_id';` — scoped naturally because every row already carries `orgId`; for global-per-org uniqueness add `orgId` to the index tuple. This is the JSONB analogue of Salesforce's `MT_Unique_Indexes` ([O'Reilly — Indexes Pivot Table](https://www.oreilly.com/library/view/the-forcecom-multitenant/30000LTI00089/30000LTI00089_ch08lev1sec5.html)).
- **App-level check** for fields not worth an index: a `findFirst` on the JSON path within `orgId` before insert/update, returning the standard `fieldErrors`. (Has a TOCTOU race; acceptable for small teams, and the partial unique index is the upgrade path.)

**(3) Evidence.** `is_unique` / `is_required` attribute flags = Attio ([Attio — attributes](https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes)). Up to 10 unique-identifier properties per object = HubSpot ([HubSpot KB](https://knowledge.hubspot.com/object-settings/create-custom-objects)). DB-enforced unique pivot = Salesforce `MT_Unique_Indexes`.

**(4) Effort:** **S–M** (Zod required is trivial; partial unique index management overlaps C3). Deps: **C1, C2**; shares tooling with **C3**.
**(5) Tier:** **Core.**

---

### C7 — Field promotion (JSONB key → real column)
**(1) Product feature:** When an org's custom field becomes business-critical and hot (heavy filter/sort/join), graduate it to a first-class typed column for full index/constraint/relation support — without users re-entering data.

**(2) Design.** A guarded, admin-triggered migration path: (a) `ALTER TABLE ADD COLUMN`; (b) backfill `UPDATE ... SET col = ("customFields"->>'key')::T` in `orgId`/id-keyed chunks across several requests (no job runner → must be chunked & resumable); (c) flip a `promotedColumn` marker on the definition so reads/writes/filtering target the column instead of JSONB; (d) optionally strip the key from JSONB later. Promotion is rare and admin-initiated, so a managed Prisma migration (committed, not runtime DDL) is the safe vehicle; the chunked backfill is the only runtime piece.

**(3) Evidence.** This is the pragmatic answer to JSONB's documented weaknesses — no DB typing/uniqueness, whole-column write locks, weak range/sort ([coussej](https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/); [Prisma — Json fields](https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields)). It also gives an escape hatch from HubSpot's "type is permanent" trap ([HubSpot Properties API](https://developers.hubspot.com/docs/guides/api/crm/properties)) by rebuilding the column with the right type during promotion.

**(4) Effort:** **M** (chunked resumable backfill is the tricky part on serverless). Deps: **C1, C2, C3**.
**(5) Tier:** **Strategic Bet.**

---

### C8 — Polymorphic activity/note attachment (controlled)
**(1) Product feature:** Attach an Activity/Note/file to *any* record type — built-in or custom object (C5) — so the timeline works everywhere. Today `Activity` FKs only to `Contact`/`Deal` (`prisma/schema.prisma`).

**(2) Design.** Activities must reference an open set of targets (including custom objects), so a pure FK can't cover it. Two patterns:
- **Default — typed join/link table with a CHECK-guarded discriminator,** keeping integrity where possible:
  ```prisma
  model ActivityLink {
    id         String   @id @default(cuid())
    orgId      String
    activityId String
    targetType CustomEntity            // CONTACT | COMPANY | DEAL | CUSTOM
    contactId  String?                 // exactly one of these set per targetType
    companyId  String?
    dealId     String?
    customRecordId String?
    @@index([orgId, targetType, contactId])
    @@index([orgId, targetType, companyId])
    @@index([orgId, targetType, customRecordId])
  }
  ```
  Real FKs (with `onDelete: Cascade`) survive for the built-in columns; only the custom-object leg is soft. A DB `CHECK` enforces "exactly one target set".
- **Generic `(targetType, targetId)` pair** only if the target set is truly unbounded — accepted as a *known* tradeoff: no FK constraints, type-string overhead, and the planner needs both columns to use an index. Use deliberately, not by default ([GitLab — Polymorphic Associations](https://docs.gitlab.com/development/database/polymorphic_associations.html); [Hashrocket](https://hashrocket.com/blog/posts/modeling-polymorphic-associations-in-a-relational-database)).

**(3) Evidence.** Associations connecting any object to activities is the HubSpot/Attio timeline model ([HubSpot data architecture](https://www.hyphadev.io/blog/complete-guide-hubspot-crm-data-architecture); [Attio — data model](https://attio.com/help/reference/attio-101/attios-data-model/understanding-attio-data-model)). The "prefer typed join tables over generic polymorphic columns" guidance is explicit at scale ([GitLab](https://docs.gitlab.com/development/database/polymorphic_associations.html)).

**(4) Effort:** **M.** Deps: builds on **C5** for the custom-object leg; standalone for built-ins.
**(5) Tier:** **Core.**

---

## 3. Effort & dependency summary

| Cap | Capability | Effort | Tier | Depends on |
|-----|------------|:------:|------|------------|
| C1 | Custom field definitions (registry + Zod engine) | M | Foundation | — |
| C2 | JSONB value storage on built-ins | S | Foundation | C1 |
| C3 | Indexing (GIN + lazy typed expression indexes) | M | Core | C2 |
| C4 | Record-reference custom fields | M | Core | C1, C2 |
| C5 | Custom objects / modules | L | Strategic Bet | C1, C2, C3 |
| C6 | Uniqueness & required validation | S–M | Core | C1, C2 |
| C7 | Field promotion (JSONB → column) | M | Strategic Bet | C1, C2, C3 |
| C8 | Polymorphic activity attachment | M | Core | C5 (custom leg) |

**Decision recap:** Hybrid (JSONB storage + metadata registry + selective typed/GIN indexes). JSONB wins on serverless zero-DDL writes, single-row reads, Prisma `Json` ergonomics, and GIN `@>` speed; the registry + lazy expression indexes recover EAV's typed indexing and validation without EAV's join cost or a custom kernel.

---

## Top 3 picks

1. **C1 — Custom Field Definitions (metadata registry + dynamic Zod engine).** Foundation for everything; nothing ships without it. Reuses the repo's Zod/ActionResult/RBAC spine and produces the same `fieldErrors` shape the UI already renders.
2. **C2 — JSONB value storage on built-in entities.** Smallest effort, highest leverage: makes custom fields real on Contact/Company/Deal with zero-DDL writes — the property that makes extensibility viable on Vercel serverless.
3. **C3 — Indexing strategy (GIN `jsonb_path_ops` + lazy typed B-tree expression indexes).** Converts the feature from "works in a demo" to "works at scale": serves equality/containment via GIN and range/sort via cast expression indexes, the documented gap in both Prisma JSON filtering and GIN.

---

### Sources
- coussej — Replacing EAV with JSONB in PostgreSQL: https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/
- PostgreSQL docs — JSON Types (datatype-json): https://www.postgresql.org/docs/current/datatype-json.html
- PostgreSQL docs — Built-in GIN operator classes (16): https://www.postgresql.org/docs/16/gin-builtin-opclasses.html
- pganalyze — Understanding Postgres GIN Indexes: The Good and the Bad: https://pganalyze.com/blog/gin-index
- Crunchy Data — Indexing JSONB in Postgres: https://www.crunchydata.com/blog/indexing-jsonb-in-postgres
- TigerData — How to Index JSON Columns in PostgreSQL: https://www.tigerdata.com/learn/how-to-index-json-columns-in-postgresql
- Prisma docs — Working with Json fields: https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields
- prisma/prisma#8977 — json vs jsonb with array_contains: https://github.com/prisma/prisma/issues/8977
- prisma/prisma#9325 — array_contains on Json in Postgres: https://github.com/prisma/prisma/issues/9325
- Salesforce Engineering — Metadata: Software The Way You Want It: https://engineering.salesforce.com/metadata-software-the-way-you-want-it-2367b179558d/
- Salesforce Architects — Platform Multitenant Architecture: https://architect.salesforce.com/fundamentals/platform-multitenant-architecture
- O'Reilly — The Force.com Multitenant Architecture, "The Indexes Pivot Table": https://www.oreilly.com/library/view/the-forcecom-multitenant/30000LTI00089/30000LTI00089_ch08lev1sec5.html
- HubSpot — Properties API: https://developers.hubspot.com/docs/guides/api/crm/properties
- HubSpot — Create and edit custom objects (KB): https://knowledge.hubspot.com/object-settings/create-custom-objects
- HubSpot — Use custom objects (KB): https://knowledge.hubspot.com/crm-setup/use-custom-objects
- HubSpot data architecture guide (Hypha): https://www.hyphadev.io/blog/complete-guide-hubspot-crm-data-architecture
- SmartBug — HubSpot custom object limits: https://www.smartbugmedia.com/blog/hubspot-custom-object
- Attio — Create and manage attributes: https://attio.com/help/reference/managing-your-data/attributes/create-manage-attributes
- Attio — Attribute types (API docs): https://docs.attio.com/docs/attribute-types/attribute-types
- Attio — Create and manage custom objects: https://attio.com/help/reference/managing-your-data/objects/create-and-manage-custom-objects
- Attio — Understanding the data model: https://attio.com/help/reference/attio-101/attios-data-model/understanding-attio-data-model
- GitLab — Polymorphic Associations (development docs): https://docs.gitlab.com/development/database/polymorphic_associations.html
- Hashrocket — Modeling Polymorphic Associations in a Relational Database: https://hashrocket.com/blog/posts/modeling-polymorphic-associations-in-a-relational-database
