# Smart-CRM Product Research — Onboarding, Search & Overall UX

**Author:** Product Research (focus area: Onboarding, search & overall UX)
**Date:** 2026-06-20
**Repo:** `/home/user/Smart-CRM`
**Scope:** saved views & advanced filtering, ⌘K command-palette expansion, first-run onboarding, empty states, i18n/l10n, accessibility (a11y), keyboard nav, bulk actions, dark mode, density/themes.

---

## Current-state assessment (what's actually in the repo)

A grounding pass through the codebase before proposing anything:

- **Command palette** — `src/components/command-palette.tsx`. A Radix `Dialog` with a hand-rolled input, 200ms-debounced calls to `globalSearch`, arrow/Enter keyboard handling, and grouped results (contact/company/deal). When the query is empty it shows a static `PAGES` list of 6 nav links. It is purely **search + navigate** — there are no *actions* (create, change theme, toggle status). The keyboard handler only supports Arrow/Enter (no Tab cycling, no `aria-activedescendant`, no `role="listbox"`/`role="option"` wiring on the results — accessibility gap).
- **Global search** — `src/server/actions/search.ts`. `globalSearch(query)` runs 3 parallel Prisma `findMany` calls using `contains … mode:"insensitive"` (substring, **not** fuzzy; no typo tolerance, no ranking, no Postgres full-text). Searches only contacts (name/email), companies (name/domain), deals (title). Does **not** search activities, phone, notes, or company industry. `LIMIT_PER_TYPE = 5`, org-scoped via `requireOrg()`. Solid, safe foundation to extend.
- **List pages** — Contacts (`src/app/(app)/contacts/page.tsx`) is the most advanced: server-rendered table, `?q=` search + single `?tag=` filter via URL `searchParams`, `take: 200`, CSV export link. Companies (`.../companies/page.tsx`) and Activities (`.../activities/page.tsx`) have **no** search/filter at all. Deals is a Kanban board (`deals/kanban.tsx`) with no list-view alternative and no filtering. **No pagination anywhere** (hard `take: 200`).
- **Empty states** — `src/components/empty-state.tsx` exists and is used consistently (title + description + single action). It's text-only — no illustration, no multi-step CTA, no sample-data offer.
- **Theming** — `next-themes@0.4.3` is in `package.json` but **never imported anywhere in `src/`** (grep confirms only `package.json`/lockfile reference it). `src/app/globals.css` *already defines a complete `.dark` palette* (lines 26–44), but no `ThemeProvider` wraps the app and no `.dark` class is ever applied, so it is dead code. Root layout hardcodes `<html lang="en">`. **Dark mode is ~90% built and 0% reachable.**
- **i18n** — none. All copy is inline English string literals across ~30 files. No `next-intl`, no locale routing, `lang="en"` hardcoded.
- **Bulk actions** — none. No row selection, no checkboxes, no bulk server actions.
- **Saved views / advanced filters** — none. No DB model for views; filtering is single-param URL state.
- **Onboarding** — none. `prisma/seed.ts` creates a rich *demo* org (`Acme Demo Co.`), but a **real** new org created via signup gets default pipeline stages only (per layout/seed split) — no checklist, no guided first-run, no sample data toggle.
- **Stack confirmed:** Next 15 App Router + RSC + server actions, React 19, Prisma/Postgres, NextAuth v5, Tailwind + shadcn/Radix, `sonner` toasts, `react-hook-form` + `zod`, `lucide-react`, `recharts`, `@dnd-kit`.

**Net:** the UX skeleton is clean and consistent but thin. The highest-leverage moves are (a) turning the palette into an *action* surface, (b) real multi-condition filtering + saved views, (c) finishing the already-paid-for dark mode, and (d) a first-run checklist — all of which map cleanly onto existing patterns (URL `searchParams`, server actions, the `requireOrg` tenancy guard, the `Dialog` palette).

---

## Ideas

### 1. Advanced multi-condition filter builder (AND/OR groups) on list pages
**Description.** Replace the contacts single-tag filter with a real filter builder: stack conditions on any field (name, email, company, title, tag, owner, created/updated date, deal stage/value/status, activity due date) using operators (is / is not / contains / is empty / before / after / greater-than) combined with **AND within a group and OR across groups**. Encode filter state in the URL (`?filter=<base64-json>` or discrete params) so it stays RSC-friendly, shareable, and bookmarkable. Render via a Radix `Popover` "Add filter" chip row above each table.

**Competitor evidence.** HubSpot's CRM index pages offer exactly this: property dropdowns plus an "Advanced filters" panel with "+ Add filter" (AND, same group) and "+ Add filter group" (OR, new group) — segments must meet all criteria in a group, or the criteria of at least one group ([HubSpot — view and filter records](https://knowledge.hubspot.com/records/view-and-filter-records)). Zoho CRM's advanced filters use AND/OR logical operators to "extract valuable sales information in less time" ([Zoho — advanced filters](https://www.zoho.com/crm/resources/tips/advanced-filters.html)). Notion lets every view carry its own filters/sorts/groups ([Notion — views, filters & sorts](https://www.notion.com/help/views-filters-and-sorts)).

**Fit with Smart-CRM.** Extends the existing `searchParams` pattern in `contacts/page.tsx`; the `where` clause is already conditionally built (`...(q ? {...} : {})`) so it generalizes to a serialized filter → Prisma `where` translator (new `src/lib/filters.ts` + a small DSL). Apply uniformly to Companies and Activities pages that currently have zero filtering. Reuse Radix `Popover` (already a dep) and shadcn `Select`/`Input`. Tenancy stays via `requireOrg()`.

**Effort:** **L** — deps: a typed filter DSL + Prisma `where` builder (security: whitelist fields/operators to avoid injection-by-shape), per-entity field registry, popover UI. Foundation for #2.
**Tier:** Must-have.

---

### 2. Saved views (per-user + shared) with default view
**Description.** Let users name and save a filter+sort+visible-columns+grouping configuration as a "View" (e.g. "My open enterprise deals", "Untagged contacts"), pin it to the sidebar/tab bar, set a personal default, and optionally **share with the team** vs keep **private**. Views are tabs at the top of each list page.

**Competitor evidence.** HubSpot: "save views for future use," clone, and manage saved views per index page ([HubSpot — create and manage saved views](https://knowledge.hubspot.com/records/create-and-manage-saved-views)). Notion's explicit per-user-vs-everyone model is the gold standard: a view's filters apply only to you unless you choose "Save for everyone" ([Notion — views, filters and sorts](https://www.notion.com/help/views-filters-and-sorts)). Zoho streamlined custom views to "group records into actionable lists while excluding noise" ([Zenatta — What's New in 2025 Zoho CRM](https://zenatta.com/whats-new-in-2025-zoho-crm-for-everyone/)). Salesforce list views are a core daily-driver surface.

**Fit with Smart-CRM.** New Prisma model `SavedView { id, orgId, ownerId, entity (CONTACT|COMPANY|DEAL|ACTIVITY), name, config Json, shared Boolean, isDefault }`, org-scoped exactly like every other model. New `src/server/actions/views.ts` (CRUD, mirrors `tags.ts`). UI: a tab strip component above tables; loading a view sets the `searchParams` from #1. Per-user vs shared maps to `ownerId` + `shared` flag. Hard dependency on #1's serialized filter format.

**Effort:** **M** (assuming #1 ships first) — deps: #1, one migration, CRUD actions, tab UI.
**Tier:** Must-have.

---

### 3. ⌘K command palette → actions + navigation (not just search)
**Description.** Expand the palette into a true command bar: a "Go to" mode (current nav), an **actions** mode (Create contact / company / deal / activity, Toggle dark mode, Switch view, Sign out, Open settings), and contextual record actions when a result is highlighted ("Add tag", "Change deal stage", "Mark activity done"). Add a leading-character grammar (`>` for commands, `@` for people, `#` for tags) like Slack/Linear, plus recent-items when the query is empty.

**Competitor evidence.** ⌘K is "the universal shortcut" across Linear, Vercel, Notion, Raycast, Slack; palettes "let users perform actions without navigating through menus" and "help users discover features they didn't know existed" ([Mobbin — Command Palette UI](https://mobbin.com/glossary/command-palette); [techinterview — Build a Command Palette like Linear and Vercel](https://www.techinterview.org/post/3233475212/build-command-palette-cmd-k/)). `kbar` exists precisely to model the Linear/Spotlight "fast, extensible cmd+k" pattern ([kbar](https://github.com/timc1/kbar)).

**Fit with Smart-CRM.** Directly extends `command-palette.tsx`: add an action registry (`{id, label, icon, perform, group, keywords}`), interleave actions with `globalSearch` hits, and route `perform` to `router.push` or a server action. Theme toggle action pairs with #7; create-actions reuse `/contacts/new` etc. Keep the existing debounce/seq logic. Consider adopting `cmdk` (shadcn's underlying lib) to get fuzzy matching + a11y roles "for free" — see #10.

**Effort:** **M** — deps: action registry; optional `cmdk` swap. Synergy with #7, #6, #10.
**Tier:** Must-have.

---

### 4. First-run onboarding checklist + guided setup
**Description.** A dismissible "Get started" checklist (3–5 steps) shown on the dashboard for new orgs: *Invite a teammate · Add your first contact · Create a company · Add a deal to the pipeline · Customize your stages*. Show a progress bar; completing all steps unlocks a small "You're set up" celebration and self-dismisses. Drive each item off real data counts (e.g. `contact.count > 0`), so it's accurate without event tracking.

**Competitor evidence.** 2025 best practice: include only **3–5 key actions that lead to activation**, make completion "unlock something meaningful," and pair each step with clear instructions; progress indicators (checklists/step counters) measurably increase completion; aim for first value in <2 min ([Candu — Best SaaS Onboarding 2025](https://www.candu.ai/blog/best-saas-onboarding-examples-checklist-practices-for-2025); [ProductLed — SaaS onboarding best practices](https://productled.com/blog/5-best-practices-for-better-saas-user-onboarding)). "Long product tours are dead" — favor contextual, data-driven nudges.

**Fit with Smart-CRM.** New dashboard component computing step completion from cheap `count` queries scoped by `requireOrg()` (no new tables needed if "dismissed" is stored on a lightweight `OrgOnboarding`/membership flag, or in a cookie for MVP). Steps deep-link to existing routes (`/contacts/new`, `/settings`, `/deals/new`). Plays directly into the empty-org reality found in seed/layout. Pairs with #5.

**Effort:** **S–M** — deps: one boolean column (or cookie) for dismissal; a checklist component. Low risk.
**Tier:** Must-have.

---

### 5. Richer empty states with sample-data seeding & contextual CTAs
**Description.** Upgrade `EmptyState` to support an icon/illustration, secondary "Learn more," and crucially a **"Load sample data"** action that seeds a few demo contacts/companies/deals into the *real* org so users can explore filtering/views/Kanban before they've entered anything — with a one-click "Clear sample data" afterward. Differentiate "no records yet" (onboarding tone + sample-data offer) from "no results for this filter" (offer to clear filters).

**Competitor evidence.** Activation hinges on reaching the "aha" moment fast and reducing the cold-start blank-slate; product-led onboarding emphasizes showing value before manual data entry ([Product School — Product-Led Onboarding 2025](https://productschool.com/blog/product-strategy/product-led-onboarding); [Candu 2025](https://www.candu.ai/blog/best-saas-onboarding-examples-checklist-practices-for-2025)). Linear/Notion seed example content into new workspaces for this reason.

**Fit with Smart-CRM.** `seed.ts` already contains a complete demo-data generator — factor its record-creation logic into a reusable `src/server/actions/sample-data.ts` that writes into the caller's `orgId` (instead of wiping + creating a fresh org). Extend the `EmptyState` props (`icon`, `secondaryAction`). Current contacts page already branches copy on `q || tagId` — generalize that. Pairs with #4.
**Effort:** **S** (empty-state props) **+ M** (sample-data action, idempotent + reversible).
**Tier:** Must-have (empty-state polish) / High (sample data).

---

### 6. Bulk actions on lists (multi-select → tag, assign, change stage, delete, export)
**Description.** Add row checkboxes + "select all (matching filter)" to list tables, revealing a sticky bulk toolbar: **Add/remove tag, Set owner, Move deals to stage, Mark activities complete, Delete, Export selection to CSV**. Show a count and an undo toast.

**Competitor evidence.** Pipedrive: selecting items opens a bulk-edit panel for field editing, bulk delete, group email, and **bulk activity scheduling** across deals/contacts/leads — gated by a "Bulk edit items" permission ([Pipedrive — bulk editing and filtering](https://support.pipedrive.com/en/article/bulk-editing-and-filtering); [Pipedrive — add activities in bulk](https://support.pipedrive.com/en/article/add-activities-bulk)). Standard table-stakes across HubSpot/Zoho/Salesforce.

**Fit with Smart-CRM.** Requires a client islands layer over the currently server-rendered tables (selection state). New bulk server actions (e.g. `bulkTagContacts(ids, tagId)`, `bulkMoveDeals(ids, stageId)`) in the existing `contacts.ts`/`deals.ts`, each re-checking `orgId` membership for every id (security-critical in multi-tenant). Permission-gate destructive bulk ops via existing `hasRole`/`rbac.ts`. Reuse `sonner` for undo toasts. Pairs naturally with #1/#2 ("select all matching this view").
**Effort:** **M–L** — deps: selection UI, batch actions with per-id tenancy checks, RBAC gating.
**Tier:** High.

---

### 7. Surface dark mode + theme toggle (finish what's already built)
**Description.** Wire up `next-themes`: add a `ThemeProvider` in the root layout, add a Light/Dark/System toggle (sidebar footer + as a palette action per #3 + in Settings), and respect `prefers-color-scheme`. The `.dark` token set already exists in `globals.css`.

**Competitor evidence.** Dark mode is a near-universal expectation in modern SaaS (Linear, Notion, Vercel, GitHub all ship it as default); command palettes routinely expose "Toggle theme" as a discoverable action ([Mobbin — Command Palette UI](https://mobbin.com/glossary/command-palette)).

**Fit with Smart-CRM.** Lowest-effort, highest-polish win: `next-themes@0.4.3` is **already installed but unused**, and a full `.dark` palette already exists at `globals.css:26–44` — only the provider + `class` strategy + a toggle are missing. Root layout already sets `suppressHydrationWarning` on `<html>` (the exact next-themes prerequisite), suggesting this was scaffolded and never finished. Add `attribute="class"` provider, a `<ThemeToggle>` in `app-sidebar.tsx`, and a palette command.
**Effort:** **S** — deps: none (everything's installed). Quick credibility win.
**Tier:** Must-have.

---

### 8. Full keyboard navigation & shortcut system (with a help overlay)
**Description.** App-wide shortcuts: `g c` → Contacts, `g d` → Deals, `g a` → Activities (Gmail/Linear "g then key" grammar), `c` → new record on the current entity, `/` → focus list search, `j/k` → move row selection, `x` → toggle row select (feeds #6), `?` → a shortcuts cheat-sheet dialog. Roving-tabindex on table rows so arrow keys move a focus ring.

**Competitor evidence.** Linear is built around keyboard-first navigation and a discoverable `?` shortcut sheet; palettes "shorten the path and let users skip the linear information architecture" ([Mobbin — Command Palette UI](https://mobbin.com/glossary/command-palette)). WCAG 2.1.1 requires all interactive elements be keyboard-operable with visible focus and no traps ([WebAIM — Keyboard Accessibility](https://webaim.org/techniques/keyboard/); [UXPin — WCAG 2.1.1](https://www.uxpin.com/studio/blog/wcag-211-keyboard-accessibility-explained/)).

**Fit with Smart-CRM.** Extends the global `keydown` listener already in `command-palette.tsx` into a small shortcut manager (`src/components/shortcuts.tsx`) mounted in the app layout; navigation uses `router.push`. Row j/k/x dovetails with #6's selection state. Help overlay is a Radix `Dialog`. Must guard against firing inside inputs/textareas.
**Effort:** **M** — deps: shortcut registry, focus management. Synergy with #3, #6.
**Tier:** High.

---

### 9. Accessibility (a11y) program: semantic tables, focus, ARIA, contrast
**Description.** A baseline WCAG 2.1 AA pass: `scope` on `<th>`, `aria-sort` on sortable headers with announced changes, `caption`/`aria-label` on each data table, visible focus rings everywhere, `role="listbox"`/`role="option"` + `aria-activedescendant` on the command palette results (currently plain `<button>`s with no listbox semantics), skip-to-content link, labelled icon-only buttons, and a contrast audit of muted text + tag colors. Add `eslint-plugin-jsx-a11y` + an `@axe-core/playwright` smoke test to the existing Playwright setup.

**Competitor evidence.** WCAG is the benchmark for ADA/Section 508 compliance; data tables need semantic markup, header `scope`, captions/labels, and `aria-sort` with announced sort changes for screen-reader users ([W3C WAI — Tables Tutorial](https://www.w3.org/WAI/tutorials/tables/); [TestParty — WCAG tables](https://testparty.ai/blog/wcag-tables-accessibility); [Level Access — Keyboard Navigation guide](https://www.levelaccess.com/blog/keyboard-navigation-complete-web-accessibility-guide/)). Enterprise CRM buyers increasingly require a VPAT.

**Fit with Smart-CRM.** Touches shared primitives (`ui/table.tsx`, `ui/button.tsx`, `command-palette.tsx`, `empty-state.tsx`) so fixes propagate everywhere cheaply. Complements #8 (focus/keyboard) and #3/#10 (palette roles). Add lint + axe to existing `eslint`/`@playwright/test` deps — no new runtime cost. Unlocks enterprise/public-sector deals.
**Effort:** **M** (initial AA pass) — deps: design tokens may need minor contrast tweaks; ongoing lint guardrail.
**Tier:** High (table-stakes for upmarket; partial overlap with #8/#10).

---

### 10. Smarter, fuzzy, scoped global search (typo-tolerant + scope chips + recents)
**Description.** Upgrade `globalSearch`: add typo tolerance and ranking (Postgres `pg_trgm` similarity + `tsvector` full-text, or trigram on names), broaden coverage to **activities, phone, notes, and company industry**, add scope chips ("Search in: Contacts ▸ Deals"), recency/relevance ranking, and "recent searches"/"recently viewed" when the box is empty. Highlight matched substrings in results.

**Competitor evidence.** Zoho's global search lets users **save searches** and filter results by module (Leads/Accounts/Contacts/Deals) ([Zoho — customize search results layout](https://www.zoho.com/crm/resources/tips/search-results-layout.html); [Zoho — advanced search](https://www.zoho.com/forms/articles/advanced-search-in-zoho-crm.html)). Linear/Vercel-class palettes lean on fast fuzzy matching for forgiving, rank-ordered results ([techinterview — Build a Command Palette](https://www.techinterview.org/post/3233475212/build-command-palette-cmd-k/)).

**Fit with Smart-CRM.** Server-side: extend `search.ts` — add a Postgres migration enabling `pg_trgm` and GIN indexes; swap `contains` for `similarity()`/`ILIKE`-ranked queries (still org-scoped). Add an entity-scope param and union activities into `SearchHit` (already a tagged union, easy to extend). Client-side: scope chips + recents in `command-palette.tsx`; "recently viewed" can be a small per-user table or localStorage MVP. Pairs with #3 (one upgraded surface serves both search and actions).
**Effort:** **M** — deps: Postgres extension + indexes (devops/migration), `SearchHit` widening, scope UI.
**Tier:** High.

---

### 11. Internationalization & localization (i18n/l10n) foundation
**Description.** Introduce `next-intl`: extract UI copy into per-locale JSON message catalogs, add locale routing or a cookie-based locale, and localize dates/numbers/**currency** (deals already carry a `currency` field — formatting should respect locale). Ship English first; structure so adding a language is "drop in a JSON file." Add a language picker in Settings.

**Competitor evidence.** `next-intl` is the de-facto i18n toolkit for the Next.js App Router, is Server-Component-friendly, supports static rendering and ICU message syntax with type-safe message keys ([next-intl — App Router](https://next-intl.dev/docs/getting-started/app-router); [DEV — i18n in Next.js 15 with next-intl, 8 languages](https://dev.to/mukitaro/a-complete-guide-to-i18n-in-nextjs-15-app-router-with-next-intl-supporting-8-languages-1lgj)). Global CRM competitors (Zoho, HubSpot, Salesforce) ship many locales; i18n is required to sell outside English markets.

**Fit with Smart-CRM.** Greenfield (no i18n today; `lang="en"` hardcoded in root layout). `next-intl` slots into the App Router with an `i18n/request.ts` config and a provider in the root layout. Highest cost is the one-time **copy extraction across ~30 files** of inline literals; ongoing cost is low. Best sequenced *after* the big UX features land so new strings are authored translation-ready rather than retrofitted twice.
**Effort:** **L** — deps: `next-intl`, message extraction, locale routing decision, ICU formatting for currency/dates.
**Tier:** Strategic / Later (gates international expansion; not day-1 for small English-speaking teams).

---

### 12. Display density & theme presets (Comfortable / Compact, accent themes)
**Description.** A per-user **density** toggle (Comfortable vs Compact row height/padding) and a few accent-color presets, persisted via `next-themes`/cookie and exposed in Settings + as palette actions. Power users managing hundreds of rows want denser tables; new users want breathing room.

**Competitor evidence.** Gmail's density control and Linear/Notion view-density options are well-worn patterns; allowing users to tune information density is a recognized power-user affordance, and view configuration (incl. layout) is core to Notion's per-view model ([Notion — views, groups, filters & properties](https://www.notion.com/help/views-groups-filters-and-properties)).

**Fit with Smart-CRM.** Builds on #7's theming plumbing: density is a `data-density` attribute on the body driving Tailwind variants in `ui/table.tsx` and shared paddings; accent presets are additional CSS-variable sets alongside the existing `:root`/`.dark` blocks in `globals.css`. Low architectural risk once #7 exists.
**Effort:** **S–M** — deps: #7 (theme provider/persistence), Tailwind density variants.
**Tier:** Nice-to-have.

---

## Effort × Tier summary

| # | Idea | Effort | Tier |
|---|------|--------|------|
| 1 | Advanced multi-condition filters (AND/OR) | L | Must-have |
| 2 | Saved views (per-user + shared) | M | Must-have |
| 3 | ⌘K palette → actions + navigation | M | Must-have |
| 4 | First-run onboarding checklist | S–M | Must-have |
| 5 | Richer empty states + sample data | S/M | Must / High |
| 6 | Bulk actions on lists | M–L | High |
| 7 | Surface dark mode / theme toggle | S | Must-have |
| 8 | Full keyboard nav + shortcut sheet | M | High |
| 9 | Accessibility (WCAG AA) program | M | High |
| 10 | Smarter fuzzy + scoped global search | M | High |
| 11 | i18n / l10n foundation | L | Strategic / Later |
| 12 | Display density & theme presets | S–M | Nice-to-have |

---

## Top 3 picks

1. **Advanced multi-condition filters + Saved views (#1 → #2).** The single biggest functional gap vs HubSpot/Zoho/Notion and the backbone of a real CRM workflow. They're a natural pair — saved views are just persisted filter configs — and both extend the existing `searchParams` + server-action + `requireOrg` patterns rather than fighting them. This is what moves Smart-CRM from "toy list" to "platform." (Effort L+M.)

2. **⌘K command palette → actions + navigation (#3), with smarter search (#10) behind it.** The palette already exists; turning it from search-only into a Linear/Notion-style command surface (create, navigate, toggle theme, run record actions) is the highest perceived-sophistication-per-effort upgrade and becomes the connective tissue for shortcuts (#8) and theming (#7). (Effort M.)

3. **First-run onboarding checklist + finish dark mode (#4 + #7).** The fastest credibility wins. Dark mode is ~90% built and 0% wired (`next-themes` installed-but-unused; full `.dark` palette already in `globals.css`; `suppressHydrationWarning` already set) — an S-effort, high-polish win. The onboarding checklist (3–5 data-driven steps, the 2025 activation best practice) plus sample-data empty states (#5) directly attack the cold-start blank slate that new orgs hit today. (Effort S + S–M.)
