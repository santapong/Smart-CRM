# Smart-CRM — Search Infrastructure Design Brief

**Scope:** Upgrade `globalSearch()` from naive substring search to scalable full-text / typeahead / faceted search across all record types, with hard multi-tenant isolation.
**Author:** Backend/Platform
**Date:** 2026-06-20
**Status:** RESEARCH / DESIGN ONLY — no repo changes proposed here, only a target architecture and sequencing.

---

## 1. Current state (what we have today)

`src/server/actions/search.ts` runs three parallel Prisma `findMany` queries with case-insensitive `contains` (i.e. `ILIKE '%q%'`) over a handful of fields, `take: 5` each, ordered alphabetically / by `updatedAt`. It powers the ⌘K palette via the `SearchHit` shape (`id/type/title/subtitle/href`).

Concrete limitations:
- **Substring only.** `contains` → `ILIKE '%q%'`. Unindexed, sequential scan per query as tables grow; no left-anchor index help because of the leading `%`.
- **No relevance ranking.** Results sorted alphabetically, not by match quality. A contact whose name *is* the query ranks the same as a partial notes hit.
- **No typo tolerance / stemming.** "Acmme" finds nothing; "running" won't match "run".
- **No facets / filters.** Cannot scope by type, stage, owner, tag, status, date.
- **Narrow coverage.** Only Contact (firstName/lastName/email), Company (name/domain), Deal (title). **Activities, notes/bodies, phone, title, industry, tags, and custom fields are not searched at all.**
- **Hard cap of 5/type** with no "see all" / pagination.

### Schema realities that shape the design
All domain rows are `orgId`-scoped (`Company`, `Contact`, `Deal`, `Activity`, `Tag`) — multi-tenant isolation must be enforced on **every** search path. Searchable text per entity:

| Entity   | High-signal (weight A/B) | Body / low-signal (weight C/D) |
|----------|--------------------------|--------------------------------|
| Company  | `name`, `domain`         | `industry`, `notes` (@db.Text) |
| Contact  | `firstName`, `lastName`, `email` | `title`, `phone`, `notes` |
| Deal     | `title`                  | `notes` |
| Activity | `title`                  | `body` (@db.Text) |
| Tag      | `name`                   | — |

**There is no custom-fields model today** — `grep` for `CustomField`/`Json`/`jsonb` finds nothing in `schema.prisma`, and there are **no migrations yet** (`prisma/migrations/**` is empty). Custom-field search is therefore a *forward-looking* design item, not a retrofit. No Prisma `previewFeatures` / `postgresqlExtensions` are enabled today.

### Hosting reality (decisive constraint)
The stack runs on Vercel; **Vercel Postgres is now Neon** (Vercel migrated all Postgres stores to Neon in Q4 2024–Q1 2025) [V1][V2]. This matters for engine choice:
- ✅ **Native FTS (`tsvector`/`tsquery`/GIN)** is core Postgres — always available, nothing to install [N-trgm][PG-trgm].
- ✅ **`pg_trgm`** (trigram fuzzy/typo + index-assisted `ILIKE`) is supported on Neon and is one of its most-installed extensions [N-trgm].
- ❌ **`pg_search` (ParadeDB BM25)** is **no longer available for new Neon projects as of 2026-03-19** (existing users keep it) [N-search]. So the "Elastic-quality BM25 inside Postgres" option is effectively **off the table for us** — if native ranking proves insufficient, the next step is an external engine, not a Postgres extension.

**Implication:** Postgres-native FTS + `pg_trgm` is the correct, low-risk first phase on *this* stack. A dedicated engine (Meilisearch/Typesense) is the Strategic Bet for when ranking quality, typo tolerance at scale, or facet UX outgrow Postgres.

---

## 2. Decision framing — Postgres FTS first, external engine later

| Dimension | Postgres FTS + pg_trgm | Meilisearch | Typesense | Elastic/OpenSearch | Algolia |
|---|---|---|---|---|---|
| Lives in our DB (no new infra, txn-consistent) | ✅ | ❌ | ❌ | ❌ | ❌ (SaaS) |
| Available on Neon/Vercel stack | ✅ | self-host/cloud | self-host/cloud | self-host/cloud | SaaS |
| Relevance ranking | `ts_rank`/`ts_rank_cd` (TF + length; **no IDF**) [PG-ctl][PD-bm25] | typo-tolerant, tuned rules | typo-tolerant, tuned | BM25 (best-in-class) | BM25, premium |
| Typo tolerance | via `pg_trgm` only (bolt-on) [Tap][PG-trgm] | built-in, excellent | built-in, excellent | built-in | built-in |
| Facets w/ counts | manual `GROUP BY` per facet | built-in distribution | built-in | built-in (aggs) | built-in |
| Typeahead (as-you-type) | trigram/prefix, "good enough" | instant, purpose-built | instant, purpose-built | good | best |
| Multi-tenant isolation | `WHERE org_id =` (trivial, in-DB) | **tenant tokens** (JWT-embedded filter) [M-mt][M-spec] | per-tenant filter / separate index [TS-cmp] | filter / index / alias | secured API keys w/ filters |
| Ops burden | ~none | low–med | low–med | **high** | none (cost = $) |
| Cost | included | infra or cloud tier | infra or cloud tier | infra-heavy | usage-based, premium |

**Recommendation: phased.**
- **Phase 1 (now):** Native Postgres FTS with `STORED` generated `tsvector` columns + GIN, weighted with `setweight`, ranked with `ts_rank_cd`, queried via `websearch_to_tsquery`. Add `pg_trgm` GIN for typeahead + typo fallback. Everything `org_id`-scoped. Covers all five entity types.
- **Phase 2 (when justified):** Introduce **Meilisearch** (best SaaS/typeahead fit per multiple 2025 comparisons [M-cmp][M-alts]) as a denormalized search index synced from Postgres, with **tenant tokens** for isolation. Defer Elastic/OpenSearch unless we need its analytics/aggregation depth (its operational overhead is the explicit reason teams pick alternatives [M-cmp]).

The rest of this brief is organized as capabilities. Each: **(1) what it enables · (2) design · (3) reference evidence · (4) Effort + deps · (5) Tier.**

---

## 3. Capabilities

### C1 — Per-entity weighted `tsvector` columns + GIN (relevance core)
**(1) Enables:** Real full-text matching with stemming and field-weighted relevance ("name" beats "notes"), replacing `ILIKE '%q%'`. Foundation everything else builds on.

**(2) Design:** Add a generated, **stored** `tsvector` column per searchable entity, concatenating `setweight`-tagged fields, indexed with GIN. Stored generated columns stay in sync automatically on write — **no triggers, no app code, no CDC** for the in-DB path.

Prisma side: declare the column as `Unsupported("tsvector")?` and the index as a raw `@@index(..., type: Gin)` isn't expressible for generated cols, so manage both via a hand-edited migration (`prisma migrate dev --create-only`). Example for `Contact`:

```sql
ALTER TABLE "Contact" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("firstName",'') || ' ' || coalesce("lastName",'')), 'A') ||
    setweight(to_tsvector('simple', coalesce("email",'')), 'A') ||
    setweight(to_tsvector('english', coalesce("title",'')), 'B') ||
    setweight(to_tsvector('simple', coalesce("phone",'')), 'C') ||
    setweight(to_tsvector('english', coalesce("notes",'')), 'D')
  ) STORED;
CREATE INDEX "Contact_searchVector_idx" ON "Contact" USING GIN ("searchVector");
```
Use `'simple'` config for names/emails/identifiers (no stemming — don't stem "Acme"), `'english'` for prose (`notes`, `title`, Activity `body`). Repeat per entity (Company: name/domain=A, industry=B, notes=D; Deal: title=A, notes=D; Activity: title=A, body=C; Tag: name=A). Default weight multipliers are A=1.0, B=0.4, C=0.2, D=0.1 [PG-ctl][One].

In `schema.prisma`:
```prisma
model Contact {
  // ...existing fields...
  searchVector Unsupported("tsvector")?
}
```
(`Unsupported` keeps Prisma's introspection/migrate happy without trying to read the column in the client.)

**(3) Evidence:** Generated `tsvector ... STORED` + `setweight` + GIN is the canonical pattern [One][Vip][L=DZone]. Weight semantics and defaults [PG-ctl]. Prisma's documented approach for advanced FTS is `Unsupported("tsvector")` + `--create-only` raw-SQL migration [Pris-fts][Clar].

**(4) Effort: M.** Deps: hand-written migration; **none on extensions** (core Postgres). Backfill is automatic for generated columns (computed on next write / table rewrite during the ALTER).

**(5) Tier: Foundation.**

---

### C2 — Ranked, tenant-scoped query via `websearch_to_tsquery` + `ts_rank_cd`
**(1) Enables:** Order results by match quality, scoped to the caller's org, with forgiving user-facing query syntax (quotes, `-exclude`, `or`).

**(2) Design:** Replace the three `findMany`s with `$queryRaw` per entity (or one `UNION ALL` ranking query). Always filter `org_id` **first** (composite index `(org_id, ...)`), then the FTS predicate:

```sql
SELECT id, 'contact' AS type,
       ts_rank_cd("searchVector", query) AS rank
FROM "Contact", websearch_to_tsquery('english', $1) AS query
WHERE "orgId" = $2
  AND "searchVector" @@ query
ORDER BY rank DESC
LIMIT $3;
```
- `websearch_to_tsquery` never throws on arbitrary user input (unlike `to_tsquery`) and supports web-style syntax [PG-ctl][Vip].
- `ts_rank_cd` (cover-density) rewards proximity of matched terms; `ts_rank` is the frequency-only variant — pick `ts_rank_cd` for short CRM records [PG-ctl][L=DZone].
- For a unified palette, wrap per-entity selects in `UNION ALL`, then `ORDER BY rank DESC, type` with a global `LIMIT`, normalizing rank across types (multiply by per-type boost so e.g. exact contact > deal-notes hit).
- **Tenant isolation** stays exactly as today (`requireOrg()` → `orgId` in `WHERE`); no FTS feature weakens it. Keep passing `orgId` as a bound parameter, never interpolated.

Keep the existing `ActionResult<{hits}>` + `SearchHit` contract so the ⌘K UI is untouched.

**(3) Evidence:** `websearch_to_tsquery` web-style syntax & safety, `ts_rank` vs `ts_rank_cd` semantics [PG-ctl][Vip][L=DZone]. Multi-column/multi-table weighting via `||` and `setweight` [One].

**(4) Effort: M.** Deps: C1. `$queryRaw` typing + a small row→`SearchHit` mapper.

**(5) Tier: Foundation.**

---

### C3 — Typeahead + typo tolerance with `pg_trgm` (fuzzy fallback)
**(1) Enables:** ⌘K feels instant on partial words ("ac" → "Acme") and survives typos ("Acmme", "jhon") — the gap pure `tsvector` cannot cover (FTS returns nothing on a misspelled lexeme).

**(2) Design:** `CREATE EXTENSION IF NOT EXISTS pg_trgm;` then add **trigram GIN** indexes on the highest-signal short fields (Contact name/email, Company name/domain, Deal/Activity title, Tag name):
```sql
CREATE INDEX "Company_name_trgm_idx" ON "Company" USING GIN (name gin_trgm_ops);
```
Two uses:
- **Index-assisted `ILIKE '%q%'` / prefix** for as-you-type: trigram GIN makes non-left-anchored `ILIKE` fast (no leading-`%` penalty) [PG-trgm][Sling].
- **Typo fallback / ranking tiebreak:** `similarity(name, $q) > 0.3` or `name % $q`, `ORDER BY similarity(...) DESC` [Tap][PG-trgm].

**Query strategy (hybrid):** primary path = FTS (C2); if the term is short (< 3 chars) or FTS yields too few hits, run the trigram path and merge. A common pattern is FTS for recall/ranking + `pg_trgm` for typo tolerance in one app-level union [Tac][Tap].

**(3) Evidence:** `pg_trgm` = trigram similarity for typos + index-assisted `ILIKE` with `gin_trgm_ops`; ideal for autocomplete [PG-trgm][Sling][Tap]. tsvector-alone misses typos — combine FTS + `pg_trgm` [Tac][Vip]. `pg_trgm` is available on Neon [N-trgm].

**(4) Effort: S–M.** Deps: `CREATE EXTENSION pg_trgm` (available on Neon [N-trgm]); merge logic in the action.

**(5) Tier: Core.**

---

### C4 — Faceted / filtered search (type, stage, owner, status, tag, date)
**(1) Enables:** "See all results" view and filtered ⌘K — scope by entity type, deal stage/status, owner, contact tag, activity due-date. Turns one-shot palette into a usable search results page.

**(2) Design (Postgres phase):** Facets are plain indexed predicates plus aggregate counts — no engine needed:
- **Type facet:** the `UNION ALL` already tags `type`; `GROUP BY type` for counts.
- **Structured facets:** add `AND "stageId" = $`, `"status" = $`, `"ownerId" = $`, `"closeDate" BETWEEN ...`; counts via a parallel `SELECT facet, count(*) ... GROUP BY facet`. Existing composite indexes (`@@index([orgId, stageId])`, `([orgId, status])`, `([orgId, dueAt])`) already back these.
- **Tag facet:** join `ContactTag`/`Tag`.
- Run facet-count queries in parallel with the result query (as the current code already parallelizes with `Promise.all`).

Caveat: many independent facet counts = many aggregates; acceptable at our scale, but this is precisely where a dedicated engine's single-pass facet distribution wins later (see C7).

**(3) Evidence:** Dedicated engines provide facet *distribution counts* out of the box (Meilisearch/Typesense), which is the motivation to migrate facets later [M-cmp][TS-cmp]. In Postgres, facets are `GROUP BY` over indexed columns [One].

**(4) Effort: M.** Deps: C2; UI surface for a results page (frontend) — out of backend scope but noted as a dependency.

**(5) Tier: Core.**

---

### C5 — Index sync strategy (decision: generated columns now, CDC/queue later)
**(1) Enables:** Correct, durable answer to "how do search indexes stay current?" — and avoids the classic dual-write inconsistency trap when/if we add an external engine.

**(2) Design — three options, explicit choice:**
1. **Generated `STORED` columns (Phase 1, chosen):** Postgres recomputes `tsvector` on every insert/update inside the same transaction. Zero app code, zero drift, transactionally consistent. Only works because the index lives *in* Postgres. **This is our Phase-1 sync story and it's effectively free.**
2. **DB triggers → outbox (bridge):** if we need to push to an external engine, a trigger writing row ids to an `search_outbox` table (drained by a worker) is more reliable than app-side dual writes; cost = Postgres trigger/function maintenance [Sync-1].
3. **CDC (Debezium/Streamkap) (Phase 2+, for external engine):** stream WAL → engine; sub-second, decoupled, no added primary load, and it eliminates the dual-write problem where app code writes both stores and drifts [Sync-1][Sync-2][Sync-3]. Cost = real infra (connector + broker) and ops.

**Anti-pattern to avoid:** naive **application-side dual writes** to Postgres + engine — race conditions, partial failures, eventual inconsistency [Sync-1][Sync-3]. If we don't run CDC, use the **trigger→outbox→worker** pattern, not inline dual writes.

**(3) Evidence:** Dual-write hazards; triggers require maintenance; CDC is the consistent/decoupled approach and pairs naturally with Meilisearch/Elastic/OpenSearch [Sync-1][Sync-2][Sync-3].

**(4) Effort: S** (Phase 1 generated cols — already implied by C1) / **L** (Phase 2 CDC pipeline). Deps: external engine (C7) for options 2–3.

**(5) Tier: Foundation** (the *decision* + Phase-1 generated-column sync) / Strategic Bet (CDC).

---

### C6 — Custom-fields search (forward-looking; no model exists yet)
**(1) Enables:** Search user-defined fields once Smart-CRM gains custom fields (a stated product gap). Designing the search story now avoids a painful retrofit.

**(2) Design:** Assume the eventual custom-field store is a **`jsonb` column** (e.g. `Contact.customFields jsonb`) or an EAV `CustomFieldValue` table. Two viable Postgres approaches:
- **jsonb → tsvector:** extend the generated column to fold custom text in, e.g. `setweight(to_tsvector('english', coalesce(jsonb_path_query_array("customFields", '$.*')::text,'')), 'C')`. Pro: rides C1's index. Con: types/keys flattened; needs care to skip non-text values.
- **EAV companion `tsvector`:** maintain a per-row aggregated `tsvector` of custom-field values via trigger when the model is EAV (generated columns can't span tables).
- For **structured custom-field filters/facets**, index specific jsonb paths with expression indexes or `jsonb_path_ops` GIN; for fuzzy, `pg_trgm` on extracted text.
- In an external engine, custom fields map cleanly to dynamic document attributes (filterable/searchable per field) — generally easier than Postgres jsonb gymnastics, a point in favor of the engine for heavy custom-field use.

**(3) Evidence:** Prisma/Postgres support native `jsonb` and GIN indexing of JSON paths [Pris-fts]; engines model arbitrary attributes as first-class filterable/searchable fields [TS-cmp][M-cmp]. (No custom-field model exists in the current schema — confirmed by grep + empty migrations dir.)

**(4) Effort: M** (after the custom-field model lands). Deps: custom-fields data model (separate workstream); C1/C5.

**(5) Tier: Strategic Bet.**

---

### C7 — Dedicated engine (Meilisearch) as denormalized index (Phase 2)
**(1) Enables:** Best-in-class typeahead, robust typo tolerance, built-in facet distributions, and tunable relevance — when Postgres ranking (no IDF) or facet-count fan-out becomes the bottleneck.

**(2) Design:** Maintain one denormalized index (or one index per entity type) of search documents `{ id, type, orgId, title, subtitle, href, ...filterable facets }`. Populate via **CDC or trigger→outbox worker** (C5), never dual writes. The server action calls the engine instead of Postgres for the palette; structured detail still loads from Postgres by id.
- **Why Meilisearch first:** 2025 comparisons position it as the recommended pick for SaaS, with search-as-you-type, sophisticated ranking rules, and faceted search with distribution counts [M-cmp][M-alts]. Typesense is the close alternative (instant search, multi-tenancy via isolated indexes [TS-cmp]); Algolia = premium SaaS, usage-priced; Elastic/OpenSearch = most powerful but highest ops burden (the very reason teams seek alternatives) [M-cmp].
- **Tenant isolation (critical):** use Meilisearch **tenant tokens** — short-lived JWTs that embed `searchRules` (per-index filters) so a token can only ever return rows matching e.g. `orgId = '<org>'`. Generated server-side per request with `generateTenantToken`, signed by an API key, with an expiry; Meilisearch decodes and applies the filter on every query and stores nothing [M-mt][M-spec]. This replaces our SQL `WHERE orgId =` with a cryptographically enforced filter. (Typesense equivalent: scoped/search-only keys or per-tenant indexes [TS-cmp].)
- **Mandatory guardrail:** every document carries `orgId`; the token's `searchRules` filter on `orgId` is non-negotiable — a missing filter = cross-tenant leak.

**(3) Evidence:** Engine comparison & SaaS recommendation [M-cmp][M-alts][TS-cmp]; tenant tokens mechanism (JWT, searchRules, API key, expiry, applied at query time, not stored) [M-mt][M-spec]; engines pair with CDC [Sync-1].

**(4) Effort: L.** Deps: C5 sync pipeline; new infra (managed Meilisearch Cloud or self-host); env/secret for engine key; per-request token minting in the action layer.

**(5) Tier: Strategic Bet.**

---

### C8 — Search observability, limits & guardrails
**(1) Enables:** Safe rollout and the data to know *when* to trigger Phase 2 — plus protection against pathological queries.

**(2) Design:**
- **Tenant safety net:** keep `requireOrg()` and bound-parameter `orgId` on every path; add a lightweight test asserting two orgs never see each other's hits (regression guard for both SQL and future tenant-token paths).
- **Query hygiene:** the existing Zod `min(1).max(100)` stays; strip control chars; short queries (<3 chars) route to prefix/trigram only (FTS lexemes are unhelpful there).
- **Pagination / "see all":** keyset pagination on `(rank, id)` to remove the hard 5/type cap.
- **Metrics:** log query latency, zero-result rate, and `EXPLAIN (ANALYZE)` periodically on the FTS/trigram queries; rising zero-result rate or p95 latency = the signal to adopt C7. Native FTS ranking lacks IDF and underperforms BM25 [PD-bm25][N-DEV] — track relevance complaints as a qualitative trigger.

**(3) Evidence:** Native ranking lacks IDF vs BM25 (quality ceiling to watch) [PD-bm25][N-DEV]; standard GIN/FTS tuning via `EXPLAIN` [One][Leap].

**(4) Effort: S.** Deps: C2.

**(5) Tier: Core.**

---

## 4. Sequencing summary

| # | Capability | Effort | Tier |
|---|-----------|--------|------|
| C1 | Weighted `tsvector` + GIN per entity | M | Foundation |
| C2 | Ranked tenant-scoped `websearch_to_tsquery` query | M | Foundation |
| C5 | Sync decision (generated cols now / CDC later) | S→L | Foundation→Strategic |
| C3 | `pg_trgm` typeahead + typo tolerance | S–M | Core |
| C4 | Faceted/filtered search | M | Core |
| C8 | Observability, limits, guardrails | S | Core |
| C6 | Custom-fields search (after model lands) | M | Strategic Bet |
| C7 | Meilisearch engine + tenant tokens | L | Strategic Bet |

---

## Top 3 picks
1. **C1 — Weighted `tsvector` + GIN per entity** (Foundation): the indexed, stemmed, field-weighted core that replaces `ILIKE '%q%'`, kept in sync for free via `STORED` generated columns. Available on our exact Neon stack with zero new infra.
2. **C2 — Ranked, tenant-scoped `websearch_to_tsquery` + `ts_rank_cd`** (Foundation): turns matching into *relevance-ordered* results behind the existing `SearchHit` contract, with `orgId` isolation preserved.
3. **C3 — `pg_trgm` typeahead + typo tolerance** (Core): makes ⌘K feel instant and forgiving (partial words + typos) — the one thing native `tsvector` cannot do — using an extension confirmed available on Neon.

---

## References
- [V1] Vercel Postgres → Neon transition. https://neon.com/docs/guides/vercel-postgres-transition-guide
- [V2] "Vercel Postgres is no longer available" (moved to Neon, 2024–2025). https://vercel.com/docs/postgres
- [N-trgm] Neon — pg_trgm extension (available; 10k+ DBs). https://neon.com/docs/extensions/pg_trgm
- [N-search] Neon — pg_search no longer available for new projects (2026-03-19). https://neon.com/docs/extensions/pg_search
- [PG-trgm] PostgreSQL docs — F.35 pg_trgm (trigram similarity, gin_trgm_ops, index-assisted LIKE/ILIKE). https://www.postgresql.org/docs/current/pgtrgm.html
- [PG-ctl] PostgreSQL docs — 12.3 Controlling Text Search (websearch_to_tsquery, ts_rank vs ts_rank_cd, setweight, weight defaults). https://www.postgresql.org/docs/current/textsearch-controls.html
- [One] OneUptime — Building Full-Text Search with GIN Indexes in PostgreSQL (generated STORED tsvector, setweight, GIN). https://oneuptime.com/blog/post/2026-01-25-full-text-search-gin-postgresql/view
- [Vip] Viprasol — PostgreSQL Full-Text Search 2026 (tsvector/tsquery, ranking, pg_trgm). https://viprasol.com/blog/postgres-full-text-search-advanced/
- [Tac] Tacnode — Full-Text Search in PostgreSQL: complete guide (FTS + pg_trgm combo). https://tacnode.io/post/full-text-search-postgresql-complete-guide
- [Tap] Tapan Basuli (Medium) — Fuzzy Search in PostgreSQL: typos & approximate matching. https://tapanbasuli.medium.com/fuzzy-search-in-postgresql-how-to-handle-typos-and-approximate-matching-02cb95ee18b8
- [Sling] Sling Academy — Using pg_trgm for better search (gin_trgm_ops autocomplete). https://www.slingacademy.com/article/how-to-use-pg-trgm-extension-for-better-search-results/
- [Leap] Leapcell — Optimizing PostgreSQL Full-Text Search performance. https://leapcell.io/blog/optimizing-postgresql-full-text-search-performance
- [L=DZone] DZone — Ranking Full-Text Search Results in PostgreSQL (ts_rank/ts_rank_cd). https://dzone.com/articles/rank-full-text-search-results-postgresql-hibernate
- [Pris-fts] Prisma docs — Full-text search (fullTextSearchPostgres preview; Unsupported("tsvector") + --create-only raw SQL). https://www.prisma.io/docs/orm/prisma-client/queries/full-text-search
- [Clar] Claritician — How to implement Full Text Search in Prisma with PostgreSQL. https://www.claritician.com/how-to-implement-full-text-search-in-prisma-with-postgresql
- [PD-bm25] ParadeDB — Implementing BM25 in PostgreSQL (native ranking lacks IDF). https://www.paradedb.com/learn/search-in-postgresql/bm25
- [N-DEV] Neon (DEV) — Comparing pg_search vs tsvector vs external engines. https://dev.to/neon-postgres/comparing-text-search-strategies-pgsearch-vs-tsvector-vs-external-engines-54f0
- [M-cmp] Meilisearch — Algolia vs Typesense vs Meilisearch (typeahead, facets, multi-tenancy, positioning). https://www.meilisearch.com/blog/algolia-vs-typesense
- [M-alts] Meilisearch — Top 10 Elasticsearch alternatives 2025. https://www.meilisearch.com/blog/elasticsearch-alternatives
- [TS-cmp] Meilisearch — Elasticsearch vs Typesense (instant search; multi-tenancy via isolated indexes). https://www.meilisearch.com/blog/elasticsearch-vs-typesense
- [M-mt] Meilisearch docs — Multitenancy and tenant tokens (generateTenantToken, searchRules, API key, expiry). https://www.meilisearch.com/docs/learn/security/tenant_tokens
- [M-spec] Meilisearch spec — Tenant Tokens (0089): JWT, searchRules filter, applied at query time, not stored. https://specs.meilisearch.dev/specifications/text/0089-tenant-tokens.html
- [Sync-1] RisingWave — Real-Time Search Indexing with CDC: Debezium→Elasticsearch (dual-write hazards; CDC). https://risingwave.com/blog/cdc-search-indexing-debezium-elasticsearch-risingwave/
- [Sync-2] Streamkap — PostgreSQL to Elasticsearch: real-time search index sync (CDC). https://streamkap.com/resources-and-guides/postgresql-to-elasticsearch-cdc
- [Sync-3] OneUptime — Streaming changes with Debezium CDC in PostgreSQL. https://oneuptime.com/blog/post/2026-01-25-debezium-cdc-postgresql/view
