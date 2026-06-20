# Smart-CRM — Import, Export & Data Migration (Design Brief)

**Author:** Backend/platform engineering
**Date:** 2026-06-20
**Scope:** Bulk CSV/XLSX import with field mapping, dedup/merge, export for all entities + full-account (GDPR) export, one-click migration from HubSpot/Pipedrive/Zoho/CSV, idempotent re-import.
**Guardrail:** Research/design only — no repo changes.

---

## 0. Current state & constraints (verified in repo)

- **Today:** Only a contacts CSV *export* exists.
  - `src/app/(app)/contacts/export/route.ts` — `GET` route, `requireOrg()` for tenant scope, `db.contact.findMany` with `company` + `tags`, builds rows, returns `text/csv`.
  - `src/lib/csv.ts` — 11 lines: `toCsv(rows)` + `escapeCell`. RFC-4180-ish quoting (`"`, `,`, `\r`, `\n`), CRLF line endings. **Write-only; there is no CSV *parser*.**
- **No import, no dedup/merge, no migration tooling.** Confirmed by grep: no `papaparse`, `xlsx`, `@vercel/blob`, `queue`, `job`, `inngest`, `trigger.dev`, `bull`, `s3` in `package.json`. Only relevant dep present is `zod@^3.23.8`.
- **Data model** (`prisma/schema.prisma`): multi-tenant by `orgId` on every domain row. Entities: `Company` (name, **domain?**, industry, size, notes), `Contact` (firstName, lastName, **email?**, phone, title, notes, `companyId?`), `Deal` (title, value `Decimal(12,2)`, currency, status enum, `stageId` **required**, companyId?, contactId?, ownerId?, closeDate), `Activity` (type enum, title, body, dueAt, completedAt, contactId?, dealId?, ownerId?), `Tag`/`ContactTag` (M:N), `PipelineStage`. **No natural unique key on Contact.email or Company.domain** — only `@@index([orgId, email])` and `@@index([orgId, name])`. Children use `onDelete: SetNull` (Deal/Activity → Contact/Company) and `Cascade` (ContactTag).
- **Helpers to reuse:** `requireOrg()` / `requireRole()` (`src/lib/tenant.ts`, `src/lib/rbac.ts`), `ActionResult`/`ok`/`fail` (`src/lib/action-result.ts`), `db` (`src/lib/db.ts`).
- **Platform limits (Vercel):** request/response body capped at **4.5 MB** (`413 FUNCTION_PAYLOAD_TOO_LARGE`); function `maxDuration` default short, extendable, with **fluid compute up to 800 s** on Pro/Enterprise; a 25k-row CSV will exceed both → **must offload upload to storage and processing to a job runner.** [Vercel limits]

**Design consequence:** the whole feature hinges on three new primitives the repo lacks — (a) **blob storage + client-side upload** (bypass 4.5 MB), (b) a **streaming parser** (CSV + XLSX), and (c) a **durable job/queue runner** to process in batches across invocations. These are shared infra; capabilities 1–9 below assume them and are tiered accordingly.

---

## Capability 1 — Import infrastructure: blob upload + job runner + `ImportJob` model

**(1) What it enables.** The foundation everything else rides on: get a large file off the browser without hitting the 4.5 MB body limit, persist a job record, and process rows in chunked batches across serverless invocations with retries and progress.

**(2) Design.**

*Upload (bypass 4.5 MB).* Use **Vercel Blob client uploads**: the browser uploads the file directly to Blob; a server route only mints a scoped token in `onBeforeGenerateToken` (where we `requireOrg()` + `requireRole(ADMIN)` and pin `allowedContentTypes`/`maximumSizeInBytes`). The large body never transits a function. Files >500 MB → Blob multipart (`createMultipartUpload`/`uploadPart`/`completeMultipartUpload`). [Vercel Blob client upload] [Vercel bypass-4.5MB]

*Job runner.* Pick a serverless-native durable runner rather than hand-rolling on Vercel Cron. Options compared below; recommend **Inngest** for step functions + fan-out + concurrency + local dev, falling back to **Upstash QStash** (HTTP queue, `$1/100k`, retries) if we want the thinnest dependency. Trigger.dev is the alternative for long single tasks. [Inngest long-running] [QStash] [QStash vs Inngest vs SQS]

*Chunking pattern.* `parse → fan-out batches of N (≈500) rows → each batch is its own invocation (one step / one QStash message) → upsert → write per-row results → update counters`. Keeps every invocation under the duration limit and gives natural retry granularity.

*Prisma sketch.*
```prisma
enum ImportEntity { CONTACT COMPANY DEAL ACTIVITY }
enum ImportStatus { UPLOADED MAPPING VALIDATING RUNNING PARTIAL DONE FAILED CANCELLED }
enum ImportDupMode { CREATE_ONLY UPDATE_ONLY UPSERT SKIP_DUPLICATES }

model ImportJob {
  id            String        @id @default(cuid())
  orgId         String
  createdById   String
  entity        ImportEntity
  status        ImportStatus  @default(UPLOADED)
  source        String        @default("CSV")   // CSV | XLSX | HUBSPOT | PIPEDRIVE | ZOHO
  blobUrl       String                            // Vercel Blob pathname
  fileName      String
  delimiter     String        @default(",")
  mapping       Json?                             // { csvHeader -> { field, transform? } }
  matchKeys     String[]      @default([])        // e.g. ["email"] / ["domain"] / ["externalId"]
  dupMode       ImportDupMode @default(UPSERT)
  importTag     String?                            // optional tag/label applied to all rows
  totalRows     Int           @default(0)
  processed     Int           @default(0)
  created       Int           @default(0)
  updated       Int           @default(0)
  skipped       Int           @default(0)
  failed        Int           @default(0)
  startedAt     DateTime?
  finishedAt    DateTime?
  createdAt     DateTime      @default(now())
  rows          ImportRowError[]

  @@index([orgId, status])
  @@index([orgId, createdAt])
}

model ImportRowError {           // only error/skip rows persisted; success is counted
  id        String   @id @default(cuid())
  jobId     String
  rowNumber Int                  // 1-based, matches source file line
  code      String              // VALIDATION | DUPLICATE | FK_MISSING | DB_ERROR
  message   String   @db.Text
  raw       Json                // the offending row, for re-export/fix-and-reimport
  job       ImportJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  @@index([jobId])
}
```
Every write is `orgId`-scoped (reuse tenant pattern). `ImportJob` status drives the UI poller.

**(3) Reference evidence.** Vercel body limit 4.5 MB and the prescribed client-upload-to-Blob escape hatch [Vercel functions limitations; Vercel KB "bypass 4.5MB"]; client-upload token handshake via `onBeforeGenerateToken` with `maximumSizeInBytes`/`allowedContentTypes` [Vercel Blob client upload docs]; serverless job runners and their fan-out/retry semantics [Inngest blog; Upstash QStash; APIScout QStash vs Inngest vs SQS].

**(4) Effort: L.** Deps: `@vercel/blob`, Inngest **or** `@upstash/qstash`, new Prisma models + migration, env vars (`BLOB_READ_WRITE_TOKEN`, runner keys).

**(5) Tier: Foundation.** Nothing else ships without it.

---

## Capability 2 — Streaming parse + column-mapping UI + Zod validation

**(1) What it enables.** Turn an arbitrary CSV/XLSX into typed, validated rows mapped to Smart-CRM fields, with auto-suggested mappings the user can correct — the core of a usable importer.

**(2) Design.**

*Parsing.* CSV via a **streaming** parser so a 100 MB file stays in constant memory (~<50 MB) instead of buffering — `csv-parse` (most spec-compliant, stream API) or `fast-csv` (fastest); **Papa Parse** is the pragmatic pick because it runs in both browser (for the preview/first-50-rows step) and Node (for the job). XLSX via **SheetJS/`xlsx`** (sheet → row objects); convert to the same row stream as CSV so downstream is format-agnostic. [csv-parse/fast-csv/papaparse comparison; Papa Parse streaming]

*Two-phase UX (mirrors Pipedrive/HubSpot).*
1. **Preview + auto-map:** read header + first ~50 rows client-side; fuzzy-match headers to fields ("First name"→`firstName`, "Email"→`email`, "Company"→company link). Pipedrive/HubSpot both auto-map by header name then let the user drag/correct unmapped columns; we replicate. [Pipedrive mapping; HubSpot single-object import]
2. **Confirm mapping + options:** user fixes mapping, picks `matchKeys` + `dupMode`, optional `importTag`. Saved to `ImportJob.mapping`.

*Validation (Zod).* Per-entity Zod schema is the contract for a parsed row:
```ts
const ContactImport = z.object({
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  email:     z.string().email().optional().or(z.literal("")),
  phone:     z.string().optional(),
  title:     z.string().optional(),
  companyName: z.string().optional(),   // resolved to companyId at upsert
  externalId:  z.string().optional(),   // for idempotent re-import (Cap 6)
});
```
Coercions live in transforms (trim, empty→`null`, `Decimal` parse for Deal `value`, date parse for `closeDate`/`dueAt`, enum normalize for `DealStatus`/`ActivityType`). Validation failures don't abort the job — they become `ImportRowError{code:"VALIDATION"}` so the rest imports (HubSpot's model: bad rows reported, good rows land). [HubSpot troubleshoot import errors]

*Relationship resolution.* `companyName`→`Company` lookup/create-if-missing within org; Deal needs a `stageId` (required FK) → map a stage column or default to the org's first `PipelineStage`; unknown owner email → leave null + warn. Missing required FK → `ImportRowError{code:"FK_MISSING"}`.

**(3) Reference evidence.** Streaming/memory characteristics and library trade-offs [npm-compare csv-parse vs fast-csv vs papaparse; PapaParse README "gracefully handles large files"]; auto-map-then-correct mapping flow [Pipedrive "importing: mapping your fields"; HubSpot import-records-for-a-single-object]; per-row error reporting w/ partial success [HubSpot "Review and troubleshoot record import errors"].

**(4) Effort: L.** Deps: `papaparse` (+ `@types/papaparse`), `xlsx`, per-entity Zod schemas, mapping UI (frontend). Depends on Cap 1.

**(5) Tier: Foundation.**

---

## Capability 3 — Batched upsert with dedup keys (CREATE_ONLY / UPSERT / SKIP)

**(1) What it enables.** Actually writes validated rows efficiently and idempotently, honoring the chosen match key so re-runs update instead of duplicating.

**(2) Design.**

*Match keys (the dedup contract).* Per entity, the user picks a key consistent with how the big CRMs dedupe:
- **Contact → email** (HubSpot dedupes contacts by email; Zoho marks email "unique"). 
- **Company → domain** (HubSpot dedupes companies by domain name). 
- **Any entity → `externalId`** (our analogue of HubSpot/Pipedrive "Record ID": if present it supersedes other keys → enables idempotent migration re-runs, Cap 6).
[HubSpot dedup; Zoho unique fields; HubSpot "Record ID supersedes other unique identifiers"]

*Schema prerequisite.* Add **partial unique indexes** so upsert can use `ON CONFLICT`:
```prisma
// Contact: unique email per org when present
@@unique([orgId, email], map: "contact_org_email_key")   // + Prisma can't do partial; use raw migration for WHERE email IS NOT NULL
// Company: unique domain per org when present
@@unique([orgId, domain], map: "company_org_domain_key")
// Optional external id for migration idempotency:
externalId String?  // + @@unique([orgId, source, externalId])
```
Because email/domain are nullable, the real DDL is a **partial unique index** (`CREATE UNIQUE INDEX ... WHERE email IS NOT NULL`) authored in a raw migration; the `@@unique` above is the logical intent.

*Batched write.* Process in batches of ~500. Strategy by `dupMode`:
- `SKIP_DUPLICATES` / `CREATE_ONLY`: `createMany({ data, skipDuplicates:true })` → single `INSERT ... ON CONFLICT DO NOTHING`, fewest round-trips. [Prisma createMany skipDuplicates → ON CONFLICT DO NOTHING]
- `UPSERT` / `UPDATE_ONLY`: Prisma `$transaction` can't batch `upsert`; use a **raw `INSERT ... ON CONFLICT (orgId,email) DO UPDATE SET ...`** per batch (Postgres-native batch upsert) — the documented workaround. [Prisma transactions limitation; Prisma uses `INSERT...ON CONFLICT` for upsert]
- Field-level on conflict update: only overwrite non-empty incoming values (don't blank existing data) — a lightweight survivorship policy shared with Cap 5.

*Counters & errors.* Each batch increments `created/updated/skipped/failed`; DB errors per row → `ImportRowError{code:"DB_ERROR"}`. Job ends `DONE` (0 failed) or `PARTIAL`.

*Concurrency safety.* Batches for the same job run with a concurrency key (Inngest concurrency / QStash flow) so two batches don't both insert the same new email (race → rely on the unique index + `ON CONFLICT` as the backstop).

**(3) Reference evidence.** `createMany({skipDuplicates})` → `ON CONFLICT DO NOTHING`, Postgres-only; batch-upsert-via-raw workaround because `$transaction` only takes `createMany/updateMany/deleteMany` [Prisma docs/discussion #21339; Medium "optimized bulk inserts with createMany"]; dedup keys email/domain/Record-ID [HubSpot KB; Zoho unique fields].

**(4) Effort: M.** Deps: raw migration for partial unique indexes; depends on Caps 1–2.

**(5) Tier: Foundation.**

---

## Capability 4 — Duplicate detection (find existing dupes already in the DB)

**(1) What it enables.** Beyond import-time matching: a standing "Duplicates" view that surfaces likely-duplicate Contacts/Companies already in the org (created via UI, multiple imports, etc.), as candidates for merge (Cap 5). Mirrors Zoho/HubSpot "De-duplicate" tooling.

**(2) Design.**

*Match strategy (tiered).*
- **Exact key:** `GROUP BY lower(email)` (contacts), `GROUP BY lower(domain)` (companies) → exact-duplicate clusters. Cheap, runs as a SQL aggregate scoped by `orgId`.
- **Fuzzy (optional, later):** normalized name + same domain, or Postgres `pg_trgm` similarity on `firstName||lastName` / company `name`. Gated behind exact match for cost.

*Surfacing.* A read endpoint returns clusters: `[{ key, count, recordIds[] }]`. Stored ad hoc (recomputed) at first; a materialized `DuplicateCandidate` table only if perf demands. Zoho's model — pick fields, system finds records with identical values and groups them — is exactly the exact-key path; up to 3 records merged at a time there, we won't cap that low. [Zoho de-duplicate; Zoho merge up to 3]

*Trigger points.* (a) On-demand from a Duplicates page; (b) post-import summary linking to clusters the import touched.

**(3) Reference evidence.** Zoho's De-duplicate (select fields → find identical → merge) and unique-field prevention [Zoho dedup/merge KB; Glion "How to deduplicate in Zoho"]; HubSpot auto-dedup by email/domain as the canonical exact keys [HubSpot dedup KB].

**(4) Effort: M** (exact-key) / **L** if fuzzy/`pg_trgm`. Deps: none beyond schema; pairs with Cap 5.

**(5) Tier: Core.**

---

## Capability 5 — Record merge: field survivorship + relink children + `MergeLog`

**(1) What it enables.** Collapse two/N duplicate records into one "golden record," choosing which field value survives, and re-point all child rows (deals, activities, tags, contacts→company) so nothing is orphaned. The hard, high-value half of dedup.

**(2) Design.**

*Survivorship.* Per the MDM "golden record" model: rules at the **attribute level** decide which source value wins. We expose three policies (Zoho requires manual conflict resolution; we offer presets + manual override):
- **Master wins** (default): keep master's value, fill blanks from others.
- **Most-recently-updated wins:** use `updatedAt` per record.
- **Manual per field:** UI lets user pick the surviving value field-by-field (Zoho's "select fields individually for the master record").
[MDM survivorship — attribute-level, recency rules; Zoho merge conflict resolution]

*Relink children (transactional).* In one `$transaction`, for the losing record(s) `loserId → masterId`:
- `Deal.update where contactId=loserId set contactId=masterId` (and `companyId` for company merges)
- `Activity.update where contactId=loserId ...`
- `ContactTag`: re-point, dedupe composite PK collisions (`(contactId,tagId)` — skip if master already has the tag)
- For company merge: `Contact.update where companyId=loserId set companyId=masterId`
- Apply survived field values to master; **soft-or-hard delete losers** (Zoho deletes losers permanently/irreversibly — we should keep a `MergeLog` snapshot to make it reversible, an improvement over Zoho).
Because schema FKs are `onDelete: SetNull`, deleting a loser without relinking would silently null children — so relink **must precede** delete.

*Prisma sketch.*
```prisma
model MergeLog {
  id         String   @id @default(cuid())
  orgId      String
  entity     ImportEntity        // CONTACT | COMPANY
  masterId   String
  loserIds   String[]
  policy     String              // MASTER_WINS | RECENT_WINS | MANUAL
  survived   Json                // final field values chosen
  snapshot   Json                // full pre-merge state of losers (for undo)
  relinked   Json                // counts: { deals, activities, tags, contacts }
  mergedById String
  createdAt  DateTime @default(now())
  @@index([orgId, createdAt])
}
```
`snapshot` enables a best-effort **undo** (recreate losers, re-split children) within a window.

**(3) Reference evidence.** Golden-record survivorship resolved per attribute, recency-based rules, deactivate the non-surviving record [Stibo/Profisee/LumenData MDM survivorship]; CRM merge mechanics, manual conflict resolution, master-field selection, irreversible loser deletion [Zoho "Merging Duplicate Records"; Zoho merge API]; CRM merge methodology [digitalapplied 2026 merge framework].

**(4) Effort: L.** Deps: Cap 4 (candidates), `MergeLog` model + migration, careful transactional relink + tests.

**(5) Tier: Core.**

---

## Capability 6 — Idempotent re-import (`externalId` / upsert keys)

**(1) What it enables.** Run the same file (or a corrected subset) twice and get the same end state — no duplicate explosion. Essential for migrations (re-run after fixing errors) and for scheduled syncs.

**(2) Design.**

*Mechanism.* Honor an **`externalId`** column (our "Record ID") as the top-priority match key: present → upsert by `(orgId, source, externalId)`; absent → fall back to email/domain; both absent → create. This is exactly HubSpot's rule that "Record ID supersedes any other unique identifiers" and the basis of Pipedrive "update existing data with a spreadsheet." [HubSpot Record ID; Pipedrive update-with-spreadsheet]

*Re-import the error set.* `ImportRowError.raw` holds each failed row → "download error rows" produces a CSV the user fixes and re-imports; because match keys are stable, fixed rows update the intended records, not new ones. (HubSpot's guidance: a duplicated alternate-ID means you picked a non-unique column — choose a better key and re-import.) [HubSpot troubleshoot]

*Job-level idempotency.* Optional `idempotencyKey` (hash of blob + mapping) so an accidental double-submit of the same job is a no-op; QStash/Inngest both support dedup keys natively. [QStash; Inngest]

**(3) Reference evidence.** Record-ID-supersedes-everything + create-when-blank semantics [HubSpot import KB]; spreadsheet-update-by-ID workflow [Pipedrive "updating data with a spreadsheet"]; runner-level idempotency keys [QStash/Inngest].

**(4) Effort: S** *(if Cap 3 already implements key precedence)* / **M** with `externalId` column + index. Deps: Cap 3.

**(5) Tier: Core.**

---

## Capability 7 — Export for all entities (CSV/XLSX), generalized

**(1) What it enables.** One-click CSV (and XLSX) export for Companies, Deals, Activities, Tags — not just Contacts — with a consistent column set and round-trip-friendly headers (so an export can be edited and re-imported).

**(2) Design.**

*Generalize the existing route.* Refactor `src/lib/csv.ts` + the contacts export into an entity-parameterized exporter: `/[entity]/export` route, per-entity column spec (header label, value getter, include relations). Reuse the proven `toCsv`/`escapeCell`.

*Round-trip headers.* Emit the same field names the importer auto-maps to, **plus a hidden/leading `externalId` = the row's `id`**, so "export → edit → re-import" updates in place (Cap 6). This is how Pipedrive/HubSpot keep export/import symmetric via Record ID.

*Large exports (mirror import constraints).* Streaming responses are exempt from the 4.5 MB body cap, so stream CSV row-by-row; for very large/XLSX exports, generate to **Vercel Blob** in a job and return a signed download URL (same infra as Cap 1). [Vercel limits — streaming exempt; Blob]

*XLSX.* SheetJS `xlsx` to write `.xlsx` (multi-sheet: one sheet per entity for a workbook export).

**(3) Reference evidence.** Streaming responses bypass the 4.5 MB limit [Vercel functions limitations]; export/import round-trip via Record ID [Pipedrive/HubSpot]; SheetJS for XLSX [SheetJS].

**(4) Effort: M.** Deps: `xlsx`; Cap 1 only for the large-export-to-Blob path.

**(5) Tier: Core.**

---

## Capability 8 — Full-account export (GDPR/portability + backup)

**(1) What it enables.** Export an entire org's data — all entities + relationships — in a structured, machine-readable archive (JSON + CSV-per-entity in a ZIP). Satisfies GDPR Art. 20 data portability, reduces switching-cost fear ("you can always get your data out"), and doubles as a backup/anti-lock-in trust signal.

**(2) Design.**

*Format.* GDPR Art. 20 requires a "structured, commonly used, machine-readable format" — **JSON for the relational graph, CSV per entity** for spreadsheet users, bundled as a ZIP. JSON preserves nested relationships (contact→company→deals→activities); CSVs are the human/round-trip layer. [GDPR Art. 20 — JSON/CSV/XML acceptable]

*Pipeline.* This is the read-side twin of import: it can exceed body + duration limits, so run as a **job** that streams each entity to NDJSON/CSV, zips, uploads to **Blob**, and emails/returns a time-limited signed URL. Scope strictly by `orgId`; `requireRole(OWNER/ADMIN)`.

*Contents.* Companies, Contacts, Deals, Activities, Tags, PipelineStages, Memberships (users by reference), plus a `manifest.json` (version, exportedAt, counts, schema version) so it's re-importable and self-describing. Personal-data export (single contact's data) is a filtered subset for DSAR responses.

*Timeline note.* GDPR mandates response within **one month**; an automated self-serve export trivially meets this. [GDPR Art. 20 timeline]

**(3) Reference evidence.** Right to data portability — structured/commonly-used/machine-readable, JSON for nested data, CSV for tabular, one-month response, optional controller-to-controller transfer where feasible [GDPR Art.20 / ICO guidance / Auth0 GDPR docs].

**(4) Effort: M.** Deps: Cap 1 (job + Blob), a zip lib (`archiver`/`jszip`).

**(5) Tier: Core** (compliance-driven; effectively required to sell to EU customers).

---

## Capability 9 — One-click migration from HubSpot / Pipedrive / Zoho / CSV

**(1) What it enables.** A guided "Switch to Smart-CRM" flow that ingests a competitor's **native export** and lands Contacts+Companies+Deals+Activities with relationships intact and minimal mapping — the core onboarding/switching-cost lever.

**(2) Design.**

*Approach: export-file adapters (not live API first).* Each competitor lets users export CSV/XLSX. Ship **per-source mapping presets** that pre-fill Cap 2's mapping for the known export schemas:
- **HubSpot:** separate Contacts/Companies/Deals exports; carry HubSpot **Record ID** → our `externalId`; associations via "Associated Company"/email/domain. 
- **Pipedrive:** Persons/Organizations/Deals exports; Person↔Org link by org name; Deal→Person/Org by name; Pipedrive Record ID → `externalId`. (Pipedrive itself recommends Import2/SyncMatters for cross-CRM moves — we replicate the file path.) 
- **Zoho:** module exports (Leads/Contacts/Accounts/Deals); Account name links Contacts; unique email/phone for dedup. 
- **Generic CSV:** the manual mapper (Cap 2).
[Pipedrive Import2 migration KB; Import2 Zoho/Pipedrive pages; Zoho data migration KB]

*Relationship preservation.* Migration runs as a **multi-entity job in dependency order**: Companies → Contacts (link by company name/domain) → Deals (link by contact/company + map pipeline/stage; create missing `PipelineStage`) → Activities (link by deal/contact). Unified tools (Import2/SyncMatters) automate exactly this object+relationship mapping; we encode the common cases as presets and fall back to manual mapping for the rest. [Import2/SyncMatters — auto map modules + relationships, test/preview]

*Idempotent & safe.* Built on Cap 6 — carry the source Record ID as `externalId` so a re-run after fixing errors updates in place. Provide a **dry-run/preview** (counts + sample + detected dupes) before commit, matching Import2's "preview/troubleshoot before migrating." [Import2 preview]

*Phase 2 (Strategic):* live API connectors (OAuth into HubSpot/Pipedrive/Zoho) to pull without manual export — same downstream pipeline, different source adapter.

**(3) Reference evidence.** Unified migration tools (Import2 / Trujay→SyncMatters) connect CRMs, auto-map modules+fields, preserve relationships, offer preview/test, free up to 1M records [Pipedrive migration blog; Pipedrive Import2 KB; Import2 product pages]; per-CRM export+mapping specifics [HubSpot import KB; Zoho migration KB].

**(4) Effort: L** (file-adapter presets) / **XL** for live-API connectors (Strategic phase). Deps: Caps 1–3, 6.

**(5) Tier: Strategic Bet** (file-import presets are Core-adjacent; live connectors are the bet).

---

## Summary table

| # | Capability | Effort | Tier | Key deps |
|---|------------|--------|------|----------|
| 1 | Import infra: Blob upload + job runner + `ImportJob` | L | Foundation | `@vercel/blob`, Inngest/QStash, migration |
| 2 | Streaming parse + mapping UI + Zod validation | L | Foundation | papaparse, xlsx, Cap 1 |
| 3 | Batched upsert w/ dedup keys | M | Foundation | partial unique indexes, Caps 1–2 |
| 4 | Duplicate detection (existing dupes) | M (L fuzzy) | Core | Cap 5 pairing |
| 5 | Record merge: survivorship + relink + `MergeLog` | L | Core | Cap 4, migration |
| 6 | Idempotent re-import (`externalId`) | S–M | Core | Cap 3 |
| 7 | Export for all entities (CSV/XLSX) | M | Core | xlsx, (Cap 1 for large) |
| 8 | Full-account export (GDPR) | M | Core | Cap 1, zip lib |
| 9 | One-click migration (HubSpot/Pipedrive/Zoho/CSV) | L (XL live API) | Strategic Bet | Caps 1–3, 6 |

---

## Top 3 picks

1. **Import infrastructure (Cap 1) + streaming parse/mapping/validation (Cap 2) + batched dedup-upsert (Cap 3)** — the Foundation triplet. This is the single highest-leverage build: it removes the #1 onboarding blocker (no import at all), and capabilities 4–9 are all impossible without it. Ship these together as the MVP importer for Contacts + Companies.
2. **Record merge with survivorship + child relink (Cap 5)** (with exact-key duplicate detection from Cap 4) — converts the inevitable mess of multiple imports/manual entry into clean golden records, with a `MergeLog` undo that beats Zoho's irreversible merge. The defining "data quality" feature that keeps the CRM trustworthy after import.
3. **One-click migration presets for HubSpot/Pipedrive/Zoho (Cap 9)** — turns Foundation+idempotency into the actual *switching-cost* weapon: a competitor's native export file becomes a populated Smart-CRM in one guided flow. Highest commercial upside; depends entirely on picks 1–2 being solid first.

---

## Sources

- Vercel Functions limits (4.5 MB body, maxDuration / fluid compute 800 s, streaming exempt): https://vercel.com/docs/functions/limitations ; https://vercel.com/docs/limits
- Bypass 4.5 MB via client upload to Blob: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- Vercel Blob client uploads (`onBeforeGenerateToken`, `maximumSizeInBytes`, multipart >500 MB): https://vercel.com/docs/vercel-blob/client-upload ; https://vercel.com/docs/vercel-blob/using-blob-sdk
- Serverless job runners (Inngest fan-out/steps; QStash queue; comparison): https://www.inngest.com/blog/vercel-long-running-background-functions ; https://dev.to/whoffagents/upstash-qstash-serverless-background-jobs-without-the-infrastructure-pain-ic8 ; https://apiscout.dev/guides/upstash-qstash-vs-inngest-vs-aws-sqs-2026
- CSV streaming parsers (csv-parse / fast-csv / papaparse): https://npm-compare.com/csv-parse,csv-parser,fast-csv,papaparse ; https://github.com/mholt/PapaParse
- Prisma bulk insert/upsert (`createMany` skipDuplicates → ON CONFLICT DO NOTHING; transaction limits; raw batch upsert): https://www.prisma.io/docs/orm/prisma-client/queries/transactions ; https://github.com/prisma/prisma/discussions/21339 ; https://medium.com/@rsharma7_be22/how-i-optimized-bulk-inserts-by-replacing-upsert-with-createmany-in-prisma-676fa74fb479
- Pipedrive import: mapping, dedup/merge, summary: https://support.pipedrive.com/en/article/importing-data-into-pipedrive-with-spreadsheets ; https://support.pipedrive.com/en/article/importing-mapping-your-fields ; https://support.pipedrive.com/en/article/updating-pipedrive-data-with-a-spreadsheet
- HubSpot import & dedup (email/domain/Record ID supersedes; per-row errors): https://knowledge.hubspot.com/import-and-export/import-records-for-a-single-object ; https://knowledge.hubspot.com/import-and-export/troubleshoot-import-errors ; https://knowledge.hubspot.com/articles/kcs_article/contacts/how-does-hubspot-deduplicate-contacts
- Zoho dedup/merge (unique fields, de-duplicate, manual conflict resolution, master-field selection): https://www.zoho.com/crm/help/miscellaneous/merge-duplicate-records.html ; https://www.zoho.com/crm/developer/docs/api/v8/merge-records.html ; https://www.glionconsulting.com/how-to-deduplicate-records-in-zoho-crm/
- MDM golden record / survivorship (attribute-level rules, recency, deactivate loser): https://service.stibosystems.com/documentation/step2025q1/content/mtchlnkmrg/survivorship/grsurvrules.html ; https://profisee.com/platform/golden-record-management/ ; https://www.digitalapplied.com/blog/crm-data-deduplication-merge-framework-2026-methodology
- Unified migration tools (Import2 / Trujay→SyncMatters): https://support.pipedrive.com/en/article/importing-data-from-a-previous-crm-using-import2 ; https://www.import2.com/zohocrm-migration ; https://www.pipedrive.com/en/blog/crm-data-migration
- GDPR Art. 20 data portability (JSON/CSV/XML, one month, controller-to-controller): https://gdpr-info.eu/art-20-gdpr/ ; https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-data-portability/ ; https://auth0.com/docs/secure/data-privacy-and-compliance/gdpr/gdpr-data-portability
