# Smart-CRM Product Research — Records & Data-Model UX

**Focus area:** Custom fields, custom objects, leads vs. contacts, lifecycle/lead stages, configurable list/table views, record layouts.
**Author:** Product Research (Records & Data-Model UX)
**Date:** 2026-06-20

## Context: where Smart-CRM is today

Reviewed `prisma/schema.prisma`, `src/server/actions/*`, and `src/app/(app)/*`. Key facts that shape every proposal below:

- **Strict fixed schema.** `Contact`, `Company`, `Deal`, `Activity` have hard-coded columns only. There is no mechanism for tenants to add their own fields. (`prisma/schema.prisma:102-240`)
- **No leads object.** Everyone who enters the system is a full `Contact`. There is no pre-qualification holding area, no lead status, no lifecycle field. (`Contact` model, `prisma/schema.prisma:120-141`)
- **Hard-coded list views.** `src/app/(app)/contacts/page.tsx` renders a fixed 5-column table (Name, Email, Company, Title, Tags). Filtering is limited to a single free-text `q` and one tag. Columns, sort, and filter sets are not user-configurable and not savable. (`src/app/(app)/contacts/page.tsx:126-171`)
- **Hard-coded record layouts.** Detail pages render a fixed two-column form (`ContactForm`) plus fixed sidebar cards. (`src/app/(app)/contacts/[id]/page.tsx`)
- **Clean, consistent patterns to build on.** Every server action follows: Zod parse -> `requireOrg()` (+ `requireRole()` for admin ops) -> Prisma scoped by `orgId` -> `revalidatePath()` -> `ActionResult`. Every business table carries `orgId` plus `(orgId, ...)` composite indexes. This is the contract any new feature must follow. (`src/lib/tenant.ts`, `src/lib/rbac.ts`, `src/lib/action-result.ts`)

The data model is the single biggest gap between Smart-CRM and HubSpot/Pipedrive/Zoho/Salesforce. The features below are sequenced so that one foundational capability (custom fields) unlocks most of the rest.

---

## Feature 1 — Custom Fields (the foundation)

**Description:** Let admins define their own fields per object (Contact, Company, Deal) — text, number, date, dropdown (single/multi-select), checkbox, URL, user-reference — that then appear on forms, detail pages, list views, and search.

**Competitor evidence:**
- **HubSpot** drives everything off "properties." Each property has a `type` (string/number/date) plus a `fieldType` (single-line text, dropdown select, radio select, date picker, HubSpot-user) that controls rendering on records and forms. Admins create them under Settings -> Properties, scoped per object. ([HubSpot — Understand property field types](https://knowledge.hubspot.com/properties/property-field-types-in-hubspot), [HubSpot Properties API](https://developers.hubspot.com/docs/api-reference/legacy/crm/properties/guide))
- **Pipedrive** offers custom fields with the same family of types (text, number, single/multi option, date, etc.) on Deals, Persons, Organizations, and exposes them in list-view columns and filters. ([Pipedrive — Custom fields](https://support.pipedrive.com/en/article/custom-fields))
- **Zoho CRM** lets admins add custom fields and surface them in custom views and page layouts. ([Zoho — Creating custom fields](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-fields/articles/use-custom-fields))

**Fit with Smart-CRM today:**
- **Schema:** Add `CustomFieldDefinition { id, orgId, entity (enum CONTACT|COMPANY|DEAL), key, label, type (enum TEXT|NUMBER|DATE|BOOLEAN|SELECT|MULTISELECT|URL|USER), options Json?, required Boolean, order Int, archived Boolean }` with `@@unique([orgId, entity, key])` and `@@index([orgId, entity, order])`. Store values via a polymorphic `CustomFieldValue { id, orgId, definitionId, entity, recordId, valueString?, valueNumber?, valueDate?, valueBool?, valueJson? }` with `@@index([orgId, entity, recordId])` and `@@unique([definitionId, recordId])`. (A typed-columns EAV table avoids a Postgres `jsonb`-only design and keeps filtering/sorting indexable — the convention the repo already favors with `(orgId, ...)` indexes.) An acceptable lighter-weight v1 alternative: a single `customFields Json?` column on each entity, deferring per-value indexing.
- **Server actions:** New `src/server/actions/custom-fields.ts` (`createFieldDefinition`, `updateFieldDefinition`, `archiveFieldDefinition`, `reorderFieldDefinitions`) gated by `requireRole(role, "ADMIN")` exactly like `updateOrgName` in `src/server/actions/org.ts:10-22`. Extend `createContact`/`updateContact` (`src/server/actions/contacts.ts`) to accept and persist a `customFields` payload; build the Zod validator dynamically from the definitions.
- **UI:** New admin screen `src/app/(app)/settings/fields/page.tsx`. A new `<CustomFieldInputs>` component rendered inside `ContactForm`/company/deal forms. Read paths in `contacts/[id]/page.tsx` join `CustomFieldValue`.

**Effort:** **L** — touches schema, all CRUD actions, all forms, and dynamic validation.
**Dependencies:** None; this is the prerequisite for Features 4, 5, 7, and 9.

**Priority tier:** **Core** (the keystone — everything else multiplies its value).

---

## Feature 2 — Leads object + Lead Inbox + convert-to-contact

**Description:** Introduce a distinct `Lead` record for unqualified inbound prospects, held in a separate "Leads" inbox until a rep qualifies or discards them. Qualifying converts a Lead into a Contact (+ optional Company + optional Deal), carrying notes and activities across.

**Competitor evidence:**
- **Pipedrive** keeps Leads in a dedicated **Leads Inbox**, separate from the pipeline; each lead is named and linked to a Person/Organization, and "Convert to deal" transfers the linked person, organization, notes, and activities into the new deal. This is the canonical small-team model. ([Pipedrive — Leads vs. deals](https://support.pipedrive.com/en/article/leads-vs-deals), [Pipedrive — Leads Inbox](https://support.pipedrive.com/en/article/leads-inbox))
- **Salesforce** treats `Lead` as a first-class standard object distinct from `Contact`, with an explicit Lead Conversion step. ([Salesforce Ben — Standard vs. Custom Objects](https://www.salesforceben.com/understanding-salesforce-standard-objects-vs-custom-objects/))

**Fit with Smart-CRM today:**
- **Schema:** New `Lead { id, orgId, name, email?, phone?, company?, title?, source?, status (enum NEW|WORKING|QUALIFIED|UNQUALIFIED), ownerId?, value Decimal?, notes?, convertedContactId?, convertedAt?, createdAt, updatedAt }` with `@@index([orgId, status])` and `@@index([orgId, ownerId])`. Mirrors the `Deal` model's owner/value/status shape (`prisma/schema.prisma:185-210`), so it slots cleanly into existing conventions.
- **Server actions:** New `src/server/actions/leads.ts` with `createLead`, `updateLead`, `setLeadStatus` (mirrors `setDealStatus`, `src/server/actions/deals.ts:89-96`), `deleteLead`, and a transactional `convertLead(id)` that creates Contact/Company/Deal in one `db.$transaction` (pattern already used in `inviteMember`, `src/server/actions/org.ts:42-52`) and stamps `convertedContactId`/`convertedAt`.
- **UI:** New nav entry in `src/components/app-sidebar.tsx` (`NAV` array) -> `src/app/(app)/leads/page.tsx` (inbox list) + `leads/[id]/page.tsx` with a prominent "Convert" button. Extend `globalSearch` (`src/server/actions/search.ts`) to include leads.

**Effort:** **L** — new object, conversion transaction, new pages, search + dashboard wiring.
**Dependencies:** Benefits from Feature 1 (custom fields on leads) and Feature 6 (record source), but ships independently.

**Priority tier:** **Strategic Bet** (defines Smart-CRM as a real sales CRM, not a contact database; clearest competitive differentiator).

---

## Feature 3 — Lifecycle stage on Contacts/Companies

**Description:** A single, ordered "lifecycle stage" property on Contacts (and Companies) — e.g. Subscriber -> Lead -> MQL -> SQL -> Opportunity -> Customer -> Evangelist — to track where each relationship sits in the funnel, independent of any one deal.

**Competitor evidence:**
- **HubSpot** ships lifecycle stage as a default, ordered property (Subscriber, Lead, MQL, SQL, Opportunity, Customer, Evangelist, Other), customizable per portal, and pairs it with a separate, tactical "Lead Status" sub-field. It is one of the most-used reporting and segmentation dimensions in the product. ([HubSpot Lifecycle Stages Explained](https://www.onthefuze.com/hubspot-insights-blog/hubspot-lifecycle-stages-explained), [Default — Lifecycle Stage & Lead Status](https://www.default.com/post/hubspot-lead-status-lifecycle-stages))

**Fit with Smart-CRM today:**
- **Schema:** Two clean options. (a) Add an enum-ish `lifecycleStage String?` directly to `Contact`/`Company` for a fast v1; or (b) make it the first **org-configurable** picklist, reusing the `PipelineStage` pattern: a `LifecycleStage { id, orgId, name, order, color }` table (near-identical to `PipelineStage`, `prisma/schema.prisma:165-177`) plus `lifecycleStageId String?` FK. Option (b) is recommended — it matches the existing ordered-picklist convention and unlocks per-org customization HubSpot users expect.
- **Server actions:** Extend `createContact`/`updateContact` (`src/server/actions/contacts.ts`) to set the stage; add a tiny `setContactLifecycleStage(id, stageId)` for inline updates (mirrors `moveDealToStage`, `src/server/actions/deals.ts:76-87`). Stage CRUD in a new `src/server/actions/lifecycle.ts`, ADMIN-gated.
- **UI:** Stage selector in `ContactForm`; a colored badge on the detail header (`contacts/[id]/page.tsx`) and as a column/filter in the contacts list. Configuration screen under `src/app/(app)/settings/`.

**Effort:** **M** (S if using a plain enum column; M for the configurable-table version).
**Dependencies:** Pairs naturally with Feature 2 (lead -> contact conversion can set initial lifecycle stage) and Feature 8 (board view of contacts by lifecycle).

**Priority tier:** **Core** (high-value segmentation primitive; modest effort on existing patterns).

---

## Feature 4 — Saved, configurable list views (columns + filters + sort)

**Description:** Replace the fixed contacts/companies/deals tables with views where users pick visible columns, multi-condition filters, and sort order — and **save** them (private or shared) and switch between them via tabs.

**Competitor evidence:**
- **Pipedrive** list views let users toggle/drag columns (gear icon), build private or shared filters, and crucially **save the column set together with the filter** so reopening a view restores both. ([Pipedrive — Customizing columns](https://support.pipedrive.com/en/article/customizing-the-columns-in-the-list-view), [Pipedrive — List view](https://support.pipedrive.com/en/article/list-view), [Pipedrive — New list views & filtering](https://www.pipedrive.com/en/blog/new-list-views-powerful-filtering-of-contacts-and-deals))
- **Salesforce** "List Views" are the standard pattern for saved, shareable, filtered, column-configurable record lists.

**Fit with Smart-CRM today:**
- **Schema:** New `SavedView { id, orgId, entity (CONTACT|COMPANY|DEAL|LEAD), name, ownerId, shared Boolean, columns Json (ordered field keys), filters Json (condition tree), sort Json, isDefault Boolean }` with `@@index([orgId, entity])`. `columns`/`filters` as `Json` is the pragmatic choice and stays consistent with how the app already passes structured payloads.
- **Server actions:** New `src/server/actions/views.ts` (`createView`, `updateView`, `deleteView`, `setDefaultView`). Refactor the contacts query in `src/app/(app)/contacts/page.tsx:24-47` to translate a saved filter tree into a Prisma `where` (start with built-in fields; extend to custom fields once Feature 1 lands).
- **UI:** A view-tab bar + a "Columns" popover and "Add filter" builder above each table; the table body becomes data-driven from the view's `columns`. Replaces the bespoke `q`/`tag` filtering currently hard-coded in `contacts/page.tsx:49-108`.

**Effort:** **L** — a generic filter-tree -> Prisma translator and a dynamic table are the heavy parts.
**Dependencies:** Much more valuable after Feature 1 (so custom fields are filterable/columnable). Reuse the same view engine across all objects.

**Priority tier:** **Core** (daily-driver UX; directly closes a named gap — "no list-view configuration").

---

## Feature 5 — Inline + bulk editing from the list

**Description:** Edit field values directly in the table (click a cell to edit) and select multiple rows to bulk-edit a field, bulk-tag, bulk-assign owner, or bulk-delete.

**Competitor evidence:**
- **Pipedrive** supports filtering, sorting, and **updating multiple records at once** from list view, plus bulk edit. ([Pipedrive — List view: filter and bulk edit](https://support.pipedrive.com/hc/en-us/articles/206529689-Bulk-editing-filtering-The-List-View-))
- HubSpot and Zoho offer equivalent inline edit + bulk-action toolbars on their index tables.

**Fit with Smart-CRM today:**
- **Schema:** None.
- **Server actions:** New `bulkUpdateContacts(ids: string[], patch)` and `bulkDeleteContacts(ids)` in `src/server/actions/contacts.ts`, scoped by `orgId` via `updateMany`/`deleteMany` (the codebase already uses `deleteMany`/`updateMany` for scoping — see `deleteContact` `contacts.ts:67-73` and `setDealStatus` `deals.ts:89-96`). `setContactTags` (`src/server/actions/tags.ts:39-66`) generalizes to a bulk tag op.
- **UI:** Row checkboxes + a sticky bulk-action bar on `contacts/page.tsx`; an editable-cell wrapper for single-field inline saves calling `updateContact`.

**Effort:** **M** — mostly client-side table interactivity plus two thin actions.
**Dependencies:** Best built on top of Feature 4's data-driven table (shared cell renderers).

**Priority tier:** **Quick Win** (big perceived-productivity gain; small backend surface).

---

## Feature 6 — Record source / "how this came in" tracking

**Description:** A standard `source` attribute on Contacts, Leads, and Deals (e.g. Manual, Import, Web Form, Referral, API) plus first-touch metadata, so teams can attribute where records originate.

**Competitor evidence:**
- **HubSpot** stamps "Original source" / "Record source" automatically on every contact as a default property and uses it heavily in reporting. ([HubSpot — Default contact properties](https://knowledge.hubspot.com/properties/hubspots-default-contact-properties))
- **Pipedrive** records a "Lead source"/"Source channel" on leads and deals.

**Fit with Smart-CRM today:**
- **Schema:** Add `source String?` (and optionally `sourceDetail String?`) to `Contact`, `Deal`, and the new `Lead`. Trivial additive columns. The CSV importer (Feature 10) and `createContact` set it automatically; manual creation defaults to "Manual".
- **Server actions:** Set `source` in `createContact`/`createDeal` (`src/server/actions/contacts.ts:27`, `deals.ts:29`) and in any import action; expose as a normal field thereafter.
- **UI:** Read-only badge on detail headers; available as a column/filter in saved views (Feature 4).

**Effort:** **S** — additive columns + a default value at create time.
**Dependencies:** None; complements Features 2, 4, and 10.

**Priority tier:** **Quick Win**.

---

## Feature 7 — Duplicate detection & merge

**Description:** Surface likely-duplicate contacts/companies (matched on email, name+company, phone, domain) and let users merge two records into one, preserving related deals/activities/tags.

**Competitor evidence:**
- **HubSpot** scans the database daily and flags potential duplicates by comparing First/Last name, email, phone, zip, and company, presenting pairs ranked by a confidence score, then offers a guided merge. ([HubSpot duplicate contacts — find, merge, prevent](https://www.hublead.io/blog/hubspot-duplicate-contacts), [Default — HubSpot Duplicates](https://www.default.com/post/hubspot-duplicates))
- A whole ecosystem (Insycle, Dropcontact, Koalify) exists because dedupe is table-stakes for data quality — strong signal of demand. ([Insycle — HubSpot deduplication](https://www.insycle.com/hubspot/deduplication/))

**Fit with Smart-CRM today:**
- **Schema:** None required for v1 (detection can be query-driven). Optionally a `MergeLog` for auditability.
- **Server actions:** New `src/server/actions/dedupe.ts`: `findDuplicateContacts()` (group by lowercased `email`, then fuzzy name+company; the app already does case-insensitive contains queries — `contacts/page.tsx:30-35`) and `mergeContacts(primaryId, dupeId)` that, in a `db.$transaction`, re-points `Deal.contactId`, `Activity.contactId`, and `ContactTag.contactId` to the primary, copies non-empty fields, then deletes the dupe. Relations are already nullable with `onDelete: SetNull` (`prisma/schema.prisma:134,204,227,235`), which makes safe re-pointing straightforward.
- **UI:** A "Duplicates" panel under `src/app/(app)/contacts/` (or Settings) listing candidate pairs with a side-by-side merge dialog (reuse `components/ui/dialog.tsx`).

**Effort:** **M** — the merge transaction and conflict UI are the real work; detection is a query.
**Dependencies:** None; higher value once import (Feature 10) increases duplicate risk.

**Priority tier:** **Core** (data-quality keystone; directly protects every other feature's value).

---

## Feature 8 — Configurable record layouts (sections + field order + show/hide)

**Description:** Let admins arrange how a record detail page looks — group fields into named sections, set order, mark required, and show/hide — instead of the current hard-coded form.

**Competitor evidence:**
- **Salesforce** page layouts control field visibility/organization, sections, and required flags per object (and per record type). ([Salesforce Ben — Standard vs. Custom Objects](https://www.salesforceben.com/understanding-salesforce-standard-objects-vs-custom-objects/))
- **Zoho CRM** page layouts define which fields appear on a record, their order, required status, and section grouping; the recommended pattern is a top section of the 5-8 most-edited fields, a middle context section, and a bottom admin section. ([Zoho — Page layout customization](https://www.aorborc.com/zoho-crm-page-layout-customization-guide/), [Amazing Business Results — Zoho page layouts](https://www.amazingbusinessresults.com/zoho-crm-page-layouts/))

**Fit with Smart-CRM today:**
- **Schema:** New `RecordLayout { id, orgId, entity, name, sections Json (array of { title, fieldKeys[] }), isDefault Boolean }` with `@@index([orgId, entity])`. `sections` as ordered `Json` references both built-in and custom-field keys.
- **Server actions:** New `src/server/actions/layouts.ts` (`saveLayout`, `setDefaultLayout`), ADMIN-gated. The detail page reads the org's default layout and renders sections dynamically.
- **UI:** A layout editor (drag fields between sections via the existing **@dnd-kit** dependency already used on the deals Kanban). `contacts/[id]/page.tsx` becomes layout-driven rather than the fixed two-column form.

**Effort:** **L** — a layout builder plus a dynamic record renderer.
**Dependencies:** Requires Feature 1 (otherwise there are too few fields to bother arranging). Pairs with @dnd-kit (already in stack).

**Priority tier:** **Strategic Bet** (premium "platform" capability; lower urgency than fields/views).

---

## Feature 9 — Field-level required & validation rules

**Description:** Per-field rules set by admins: required, min/max, regex/format (e.g. phone, URL), and uniqueness — enforced consistently on create/edit and surfaced as inline form errors.

**Competitor evidence:**
- **HubSpot** property definitions carry validation/required semantics tied to `fieldType` (e.g. number vs. date vs. dropdown constrain input). ([HubSpot — Property field types](https://knowledge.hubspot.com/properties/property-field-types-in-hubspot))
- **Zoho CRM** lets admins mark fields required and applies field-level rules within page layouts. ([Zoho — Creating custom fields](https://help.zoho.com/portal/en/kb/crm/customize-crm-account/customizing-fields/articles/use-custom-fields))

**Fit with Smart-CRM today:**
- **Schema:** Extend `CustomFieldDefinition` (Feature 1) with `required Boolean`, `unique Boolean`, `min Int?`, `max Int?`, `pattern String?`. For built-in fields, store overrides in a small `FieldConfig` table or reuse the same definitions table with a `builtin Boolean`.
- **Server actions:** The dynamic Zod builder in `custom-fields`/`contacts.ts` reads these rules and composes the validator at runtime — slots directly into the existing `safeParse` -> `fail("Invalid input", fieldErrors)` flow used everywhere (e.g. `contacts.ts:23-24`). The `ActionResult.fieldErrors` channel (`src/lib/action-result.ts:9-11`) already carries per-field messages to the form.
- **UI:** Required asterisks and inline errors render through the existing form-error path; rule editing lives in the Feature 1 fields admin screen.

**Effort:** **M** — concentrated in the dynamic validator; UI mostly reuses existing error rendering.
**Dependencies:** Hard dependency on Feature 1.

**Priority tier:** **Core** (data integrity; cheap once custom fields exist).

---

## Feature 10 — Guided CSV import with field mapping (+ dedupe on import)

**Description:** Upload a CSV, map columns to Smart-CRM fields (built-in and custom), preview, and import — with an "update existing on email match" option to avoid creating duplicates. Complements the existing CSV **export**.

**Competitor evidence:**
- All four competitors treat import-with-mapping as table-stakes; **Freshsales** and HubSpot additionally auto-set record source on import and run dedupe on the matching key. ([HubSpot duplicate contacts](https://www.hublead.io/blog/hubspot-duplicate-contacts))
- **Freshsales** even auto-enriches imported records (company, website, size) from the email/domain. ([AeroLeads — Freshsales auto profile enrichment](https://aeroleads.com/blog/use-auto-profile-enrichment-freshsales/))

**Fit with Smart-CRM today:**
- **Schema:** Optional `ImportBatch { id, orgId, entity, filename, createdById, rowCount, createdAt }` for traceability and undo; not strictly required for v1.
- **Server actions:** New `src/server/actions/import.ts`: `previewImport(rows, mapping)` and `commitImport(rows, mapping, { upsertOnEmail })`, scoped by `orgId`, using `createMany`/`upsert`. There is already a CSV helper (`src/lib/csv.ts`) and an export route (`src/app/(app)/contacts/export/route.ts`) to mirror for symmetry.
- **UI:** New `src/app/(app)/contacts/import/page.tsx` with a 3-step wizard (upload -> map -> preview/commit), placed next to the existing "Export CSV" button on `contacts/page.tsx:60-65`.

**Effort:** **M** — mapping UI + a robust commit path (chunking, error rows).
**Dependencies:** Stronger with Feature 1 (map to custom fields), Feature 6 (stamp source=Import), and Feature 7 (dedupe on the match key).

**Priority tier:** **Core** (the obvious counterpart to existing export; primary on-ramp for real data, which makes every other feature useful on day one).

---

## Feature 11 — Custom objects (configurable modules)

**Description:** Let admins define entirely new record types ("modules") — e.g. Properties, Subscriptions, Projects, Assets — with their own fields, list views, and detail pages, related back to Contacts/Companies/Deals.

**Competitor evidence:**
- **Salesforce** custom objects exist precisely for data that "does not naturally fit" standard objects, giving full list/detail/reporting treatment. ([Salesforce Ben — Standard vs. Custom Objects](https://www.salesforceben.com/understanding-salesforce-standard-objects-vs-custom-objects/))
- **Zoho CRM** custom modules (now down to Standard/Professional editions) let businesses model arbitrary entities with custom fields, views, and layouts. ([Zoho — Custom Modules availability](https://help.zoho.com/portal/ar/community/topic/custom-modules-now-available-for-standard-and-professional-editions-with-expanded-limits-across-all-editions))

**Fit with Smart-CRM today:**
- **Schema:** A metadata-driven design: `ObjectDefinition { id, orgId, key, labelSingular, labelPlural, icon }` + reuse `CustomFieldDefinition` (extend its `entity` to reference an `objectDefinitionId`) + a generic `CustomRecord { id, orgId, objectDefinitionId, displayName, createdAt }` whose values live in the `CustomFieldValue` table from Feature 1. Relationships to core objects via a `RecordLink { fromType, fromId, toType, toId }` join.
- **Server actions:** A generic `src/server/actions/records.ts` (`createRecord`, `updateRecord`, `deleteRecord`, `listRecords`) that resolves the object definition, builds validation dynamically, and scopes by `orgId` — same contract as today's typed actions, just data-driven.
- **UI:** A dynamic route `src/app/(app)/objects/[objectKey]/page.tsx` + `[recordId]/page.tsx` reusing the Feature 4 list engine and Feature 8 layout renderer. New entries appear automatically in the sidebar (`app-sidebar.tsx`).

**Effort:** **L (XL)** — the most ambitious item; effectively a mini metadata engine.
**Dependencies:** Hard dependency on Features 1, 4, and 8. Should be the capstone, not an early bet.

**Priority tier:** **Strategic Bet** (the move that makes Smart-CRM a *platform* rather than an app — but only worthwhile after fields/views/layouts ship).

---

## Sequencing summary

| # | Feature | Effort | Tier |
|---|---------|--------|------|
| 1 | Custom Fields (foundation) | L | Core |
| 2 | Leads object + Inbox + convert | L | Strategic Bet |
| 3 | Lifecycle stage | M | Core |
| 4 | Saved configurable list views | L | Core |
| 5 | Inline + bulk editing | M | Quick Win |
| 6 | Record source tracking | S | Quick Win |
| 7 | Duplicate detection & merge | M | Core |
| 8 | Configurable record layouts | L | Strategic Bet |
| 9 | Field-level required & validation | M | Core |
| 10 | Guided CSV import + mapping | M | Core |
| 11 | Custom objects / modules | L–XL | Strategic Bet |

**Recommended build order:** 6 -> 1 -> 9 -> 10 -> 3 -> 4 -> 5 -> 7 -> 2 -> 8 -> 11. (Ship the Quick Win 6 first; stand up the custom-field foundation 1+9; bring real data in via 10; then layer views, editing, dedupe; then the Strategic Bets.)

---

## Top 3 picks

1. **Custom Fields (Feature 1)** — The single highest-leverage investment. It is the named #1 gap, the foundation for validation, configurable views, layouts, and custom objects, and the baseline every competitor (HubSpot properties, Pipedrive/Zoho custom fields) treats as table-stakes. Nothing else in this brief reaches full value without it.

2. **Leads object + Lead Inbox + convert-to-contact (Feature 2)** — The clearest competitive differentiator and the feature that turns Smart-CRM from a contact database into a sales CRM. Directly models the Pipedrive Leads-Inbox / Salesforce Lead-conversion workflow that small sales teams expect, and it fits the existing `Deal`-style schema and transactional-action patterns cleanly.

3. **Saved, configurable list views (Feature 4)** — The daily-driver UX win that closes the explicit "no list-view configuration" gap. Configurable columns + saved filters (the Pipedrive model) is what reps interact with all day, and the same view engine is reused across Contacts, Companies, Deals, Leads, and (later) custom objects — maximum leverage per unit of work.
