# Smart-CRM Research — Lead Generation & Capture

**Author:** Marketing researcher (Lead generation & capture)
**Date:** 2026-06-20
**Scope:** Embeddable web forms, hosted landing pages, public form API/endpoint, chat/live-chat widget, lead scoring & qualification, a Leads inbox separate from Contacts, deduplication on capture, source/UTM capture.

---

## Context: where Smart-CRM stands today

Read of the repo (`prisma/schema.prisma`, `src/server/actions/*`, `src/lib/*`, `src/app/*`) establishes the patterns every idea below should follow:

- **Multi-tenant** via `Organization` + `Membership`. Every domain row carries `orgId`; queries scope through `requireOrg()` → `{ userId, orgId, role }` (`src/lib/tenant.ts`).
- **Server actions** are the write path: Zod-validate input, `requireOrg()`, Prisma write, `revalidatePath(...)`, return `ActionResult<T>` (`src/lib/action-result.ts`). See `src/server/actions/contacts.ts` as the canonical example.
- **RBAC** is rank-based (`MEMBER < ADMIN < OWNER`) via `requireRole()` (`src/lib/rbac.ts`).
- **Route handlers** already exist and demonstrate the non-action HTTP path: `src/app/(app)/contacts/export/route.ts` (CSV, `requireOrg()`-gated) and `src/app/api/auth/[...nextauth]/route.ts`. There is a clean `src/app/api/` directory to add public route handlers under.
- **Contact** already has `@@index([orgId, email])` — a ready-made foundation for dedup-on-capture.
- **No** public unauthenticated endpoints, **no** rate-limiting, **no** email/webhook infra, **no** CAPTCHA, **no** background jobs yet. New public-facing capture surfaces must bring their own abuse controls.
- Stack confirmed (`package.json`): Next.js 15.0.3 App Router, React 19 RC, Prisma 5.22, NextAuth 5 beta, Tailwind+shadcn (Radix), `react-hook-form` + `zod`, `@t3-oss/env-nextjs`, `sonner` toasts, `recharts`. No Redis, no queue, no Stripe.

**The strategic gap:** Smart-CRM can only create records by an authenticated user manually filling a form. There is no way for the outside world (a prospect on a website) to *enter* the CRM. Lead capture is the single biggest missing growth surface. The competitor pattern is consistent: forms + chat feed a **Leads** object (distinct from Contacts), leads are **scored/qualified**, then **converted** to Contacts/Deals.

### Competitor landscape (anchors used throughout)

- **HubSpot Forms** — embeddable forms with **smart fields** (auto-fill known data) and **progressive profiling** (ask the *next* unknown question once a field is already captured; prioritized question order; Pro/Enterprise). Dedup-by-email is "deeply embedded… cannot be turned off": a submission matching an existing email **updates** that contact rather than creating a duplicate; cookie/user-token matching also de-dupes. ([HubSpot progressive profiling blog](https://www.hubspot.com/blog/bid/33993/hubspot-forms-now-feature-progressive-profiling-and-a-new-interface), [HubSpot dedup KB](https://knowledge.hubspot.com/crm-setup/deduplication-of-contacts-companies-deals-tickets), [HubSpot community: form updates existing contact](https://community.hubspot.com/t5/CRM/when-i-submit-a-form-on-landing-page-its-update-an-existing/td-p/1188118))
- **HubSpot Lead Scoring** — **manual (rule-based)** and **predictive (AI)**; combines **fit** (job title, email domain, company size) and **engagement/intent** (page views, form fills, pricing-page visits) with positive and negative attributes and score thresholds. ([HubSpot lead scoring product](https://www.hubspot.com/products/marketing/lead-scoring), [HubSpot scoring KB](https://knowledge.hubspot.com/scoring/understand-the-lead-scoring-tool), [Fit-over-engagement guide](https://thedigitalring.com/insights/how-to-implement-lead-scoring-in-hubspot-crm))
- **Pipedrive LeadBooster** — bundle of **Web Forms**, **Chatbot** (scripted "playbooks" with "cards" to capture info, schedule meetings, route to a rep), **Live Chat** (rep takeover), and **Prospector**, all feeding a **Leads Inbox** that is *separate from deals*: new leads appear bold with a blue dot; leads are later converted to deals. ([LeadBooster add-on KB](https://support.pipedrive.com/en/article/leadbooster-add-on), [Pipedrive Web Forms](https://www.pipedrive.com/en/features/web-forms), [Pipedrive Chatbot](https://www.pipedrive.com/en/features/lead-generation-software/chat-bot), [Pipedrive Web Chat](https://www.pipedrive.com/en/features/web-chat))
- **Pipedrive Web Forms specifics** — embed via **share link** or **JS/iframe code snippet** ("Share & Embed" tab); customizable field types (text, dropdown, checkbox); **"Create Lead" or "Create Deal"** action with field mapping; styling (colors, fonts, logo). ([Pipedrive Web Forms feature](https://www.pipedrive.com/en/features/web-forms), [embed KB via search](https://support.pipedrive.com/hc/en-us/articles/360000680329), [Pipedrive forms guide](https://www.feathery.io/blog/pipedrive-forms))
- **Typeform** — conversational, one-question-at-a-time forms with **logic jumps** (visual branching), a **calculation** feature for scoring/quote builders, **hidden fields** for UTM/attribution capture, and **webhooks** that push submissions to any endpoint in real time. ([Typeform logic jumps](https://www.typeform.com/developers/create/logic-jumps/), [Typeform community: UTM hidden fields](https://community.typeform.com/share-your-typeform-6/utm-tracking-codes-on-embedded-conversational-forms-549))
- **Conversion evidence** — conversational/multi-step formats consistently out-convert single-page forms: Typeform cites ~57% vs 10–15%; HubSpot reports ~86% higher conversion for multi-step; Venture Harbour saw 0.96% → 8.1%. Strong case for both multi-step UX and chat. ([Venture Harbour](https://ventureharbour.com/multi-step-lead-forms-get-300-conversions/), [Digioh multi-step](https://www.digioh.com/blog/multi-step-forms), [WPForms forms vs conversational](https://wpforms.com/lead-forms-vs-conversational-forms/))
- **Spam protection** — **honeypot** (hidden field bots fill, humans don't; zero friction) is the recommended first line; **reCAPTCHA** (esp. invisible v3) is a heavier second layer for aggressively targeted forms and is known to reduce completions. ([Growform honeypot](https://www.growform.co/glossary/anti-spam-honeypot/), [Webflow honeypot](https://help.webflow.com/hc/en-us/articles/45025662151827-Use-the-honeypot-technique-to-filter-spam-form-submissions))

A consistent shape emerges across all four products: **Form/Chat → public capture endpoint → Lead object → dedup + scoring → convert to Contact/Deal.** The ideas below build Smart-CRM toward exactly that, in dependency order.

---

## Idea 1 — `Lead` object + Leads Inbox (separate from Contacts)

**Description.** A first-class `Lead` model distinct from `Contact`: an unqualified, possibly-anonymous inbound record (name/email/phone optional, company text, message, source, UTM, score, status, ownerId). A dedicated **Leads Inbox** screen (`/leads`) shows newest-first, unread leads visually flagged, with filters by source/status/score/owner and a **"Convert"** action that promotes a Lead into a `Contact` (and optionally a `Deal`), linking back via `convertedContactId`. This is the keystone every other idea plugs into.

**Competitor evidence.** Pipedrive's **Leads Inbox** is explicitly a holding area *separate from deals* — "new leads will appear in bold at the top of your Leads Inbox with a blue circle" and are later converted to deals ([LeadBooster KB](https://support.pipedrive.com/en/article/leadbooster-add-on)). Pipedrive web forms/chatbot let you choose **"Create Lead" or "Create Deal"** ([Pipedrive Web Forms](https://www.pipedrive.com/en/features/web-forms)). The Lead-vs-Contact distinction (raw inbound vs vetted person) is the universal CRM convention HubSpot, Pipedrive, and Salesforce all follow.

**Fit with Smart-CRM.**
- **Schema:** new `Lead` model — `id, orgId, firstName?, lastName?, email?, phone?, companyName?, message?, source (enum: FORM | CHAT | API | IMPORT | MANUAL), status (enum: NEW | WORKING | QUALIFIED | UNQUALIFIED | CONVERTED), score Int @default(0), ownerId?, readAt?, convertedContactId?, convertedDealId?, createdAt, updatedAt`. Indexes `@@index([orgId, status])`, `@@index([orgId, createdAt])`, `@@index([orgId, email])` (mirrors Contact). Add `leads Lead[]` to `Organization`. Reuse `LeadStatus`/`LeadSource` enums like existing `DealStatus`/`ActivityType`.
- **Server actions** (`src/server/actions/leads.ts`): `updateLeadStatus`, `assignLead`, `markRead`, `convertLead` (creates Contact in a `db.$transaction`, sets `status=CONVERTED` + `convertedContactId`, optional Deal in default stage, `revalidatePath("/leads")` + `/contacts`). Follow the exact `requireOrg()` → Zod → `ActionResult` shape from `contacts.ts`.
- **UI:** `/leads` list (shadcn table) + detail drawer with Convert button; add "Leads" to the app nav. Unread = bold row + dot, matching Pipedrive.
- **RBAC:** any MEMBER can view/work; align convert/delete with how `deals.ts` gates.

**Effort:** **M.** Deps: none (foundational). Everything else (forms, chat, scoring, API) writes into this.

**Tier:** **Must-have / Tier 1.** This is the foundation; build first.

---

## Idea 2 — `Form` builder + `FormSubmission` store + embeddable form

**Description.** Let users define a `Form` in-app (name, ordered field list as JSON, target = create Lead/Contact, success message/redirect, notify settings) and get a snippet to put on any website. Each public submit creates a `FormSubmission` (raw payload, immutable audit) **and** a `Lead`. v1 ships a clean **iframe-hosted** form (`/f/[formId]`) plus a copy-paste `<script>` loader; this avoids cross-origin CSS/CSP headaches while still being "embed anywhere."

**Competitor evidence.** Pipedrive Web Forms: build with "customizable fields from text fields to dropdowns and checkboxes," choose **Create Lead/Create Deal** + field mapping, share via **link or code snippet** from a "Share & Embed" tab ([Pipedrive Web Forms](https://www.pipedrive.com/en/features/web-forms), [embed KB](https://support.pipedrive.com/hc/en-us/articles/360000680329)). HubSpot's forms are natively embeddable ([HubSpot forms](https://www.hubspot.com/blog/bid/33993/hubspot-forms-now-feature-progressive-profiling-and-a-new-interface)). Storing raw submissions separately from the resulting record matches how every form tool keeps a submission history independent of the CRM contact.

**Fit with Smart-CRM.**
- **Schema:** `Form { id, orgId, name, slug @unique-per-org, fields Json, target enum, successMessage?, redirectUrl?, notifyEmails String[], isActive, createdAt, updatedAt }`; `FormSubmission { id, orgId, formId, payload Json, leadId?, sourceUrl?, utm Json?, ip?, userAgent?, createdAt }`. Relations to `Organization`, `Form`, `Lead`.
- **Public route handler:** `src/app/api/public/forms/[formId]/route.ts` (`POST`) — **unauthenticated**, looks up Form by id (no `requireOrg`; derives `orgId` from the Form), Zod-validates against the form's field schema, runs dedup (Idea 7) + scoring (Idea 5), writes `FormSubmission` + `Lead`, returns success JSON. This is the project's first public write endpoint — a notable departure from the `requireOrg()`-gated norm, so it must bring rate-limiting (Idea 12) and a honeypot (Idea 11).
- **Hosted render:** `src/app/(public)/f/[formId]/page.tsx` renders the form from config with `react-hook-form` + a Zod schema derived from `fields`; posts to the public route.
- **Builder UI:** authenticated `/forms` CRUD + a field editor; server actions `createForm`/`updateForm`/`toggleForm` in `src/server/actions/forms.ts` (standard pattern). "Embed" tab shows the snippet, à la Pipedrive.

**Effort:** **L** (builder UI + public endpoint + hosted render + embed loader). Deps: **Idea 1** (writes Leads), and pairs with **7/11/12**. A thinner first slice: one hard-coded "Contact us" form to ship the endpoint fast.

**Tier:** **Must-have / Tier 1.** The primary capture mechanism.

---

## Idea 3 — Hosted landing pages for forms

**Description.** A standalone, brandable hosted page per form (logo, headline, subcopy, hero image, theme color, the form) at `/p/[slug]` — a zero-code landing page for campaigns, ads, and link-in-bio, for teams without a website or wanting a dedicated campaign URL.

**Competitor evidence.** Pipedrive web forms can be shared as a **standalone link** (not only embedded): "Share as link or Embed the form on your website" ([Pipedrive Web Forms](https://www.pipedrive.com/en/features/web-forms)). HubSpot, Typeform, and Pipedrive all offer hosted form/landing URLs so a form can run without an existing site. Conversational/dedicated pages convert markedly better than buried forms ([Venture Harbour 743% case](https://ventureharbour.com/multi-step-lead-forms-get-300-conversions/)).

**Fit with Smart-CRM.**
- **Schema:** extend `Form` with `landingTitle?, landingSubtitle?, landingLogoUrl?, landingThemeColor?, landingHeroUrl?` (or a small `LandingPage` model 1:1 with Form if it grows).
- **Route:** `src/app/(public)/p/[slug]/page.tsx` — public RSC, looks up active Form by `orgId+slug`, renders hero + the same form component from Idea 2, sets page `metadata` (title/OG) for shareable links. Reuses Tailwind/shadcn primitives already in the repo.
- No new write path — reuses Idea 2's public endpoint. UTM (Idea 4) is captured from the landing URL automatically.

**Effort:** **M.** Deps: **Idea 2** (renders the same form + endpoint). Mostly presentational.

**Tier:** **Tier 2 (high-value).** Big lift for ad/campaign teams; low marginal cost once forms exist.

---

## Idea 4 — Source & UTM capture on every inbound

**Description.** Capture `utm_source/medium/campaign/term/content`, referrer, and landing path on every form/chat/API submission and persist them on the `Lead` (and `FormSubmission`). Surface as columns/filters in the Leads Inbox and roll up into a "Leads by source/campaign" view so marketing can attribute spend.

**Competitor evidence.** Typeform uses **hidden fields** to "capture attribution data, UTM parameters, and pre-filled information without visitor input" ([Typeform UTM hidden fields](https://community.typeform.com/share-your-typeform-6/utm-tracking-codes-on-embedded-conversational-forms-549), [Typeform logic jumps/hidden fields](https://www.typeform.com/developers/create/logic-jumps/)). Pipedrive forms support hidden fields for the same purpose ([Pipedrive forms guide](https://www.feathery.io/blog/pipedrive-forms)). Source tracking is table-stakes for proving lead-gen ROI.

**Fit with Smart-CRM.**
- **Schema:** add `utm Json?` (or discrete columns) + `referrer?`, `landingPath?` to `Lead`; already proposed on `FormSubmission`.
- **Capture:** hosted form/landing reads `window.location` UTM params into hidden inputs (Typeform pattern); the embed `<script>` forwards parent-page UTMs via `postMessage` to the iframe. Public endpoint also reads `Referer` header as fallback.
- **UI:** add Source/Campaign columns + filter to `/leads`; a small `recharts` "Leads by source" card on the dashboard (recharts already used).

**Effort:** **S.** Deps: **Ideas 1–2** (rides existing payloads). Schema columns + a few form fields + filters.

**Tier:** **Must-have / Tier 1.** Cheap, and the ROI story for the whole module.

---

## Idea 5 — Rule-based lead scoring & qualification

**Description.** Org-configurable scoring rules combining **fit** (job title keywords, email domain, company size, country) and **engagement/intent** (form submitted, specific page visited, repeat submission), each with positive or negative points and a default. Compute a `score` on capture, bucket into **tiers** (Cold/Warm/Hot via thresholds), auto-flag/route Hot leads (e.g., auto-assign owner, notify). Editable rules so admins tune without code.

**Competitor evidence.** HubSpot offers **manual (rule-based)** scoring with positive/negative attributes and explicitly blends **fit** (job title, email domain, company size) with **engagement/intent** (email opens, blog visits, pricing-page views, demo requests), using score thresholds to prioritize ([HubSpot lead scoring](https://www.hubspot.com/products/marketing/lead-scoring), [scoring KB](https://knowledge.hubspot.com/scoring/understand-the-lead-scoring-tool), [fit-over-engagement](https://thedigitalring.com/insights/how-to-implement-lead-scoring-in-hubspot-crm)). Typeform's **calculation** feature lets forms compute scores inline ([Typeform logic jumps](https://www.typeform.com/developers/create/logic-jumps/)). Pipedrive chatbots qualify and route based on answers ([Pipedrive Chatbot](https://www.pipedrive.com/en/features/lead-generation-software/chat-bot)).

**Fit with Smart-CRM.**
- **Schema:** `ScoringRule { id, orgId, field (enum: EMAIL_DOMAIN | TITLE | COMPANY_SIZE | COUNTRY | SOURCE | FORM_ID | PAGE_URL ...), operator (CONTAINS | EQUALS | IN | EXISTS), value String, points Int, isActive }`; add `scoreTier` (CHILLED/WARM/HOT) to `Lead`, plus org-level thresholds (store on `Organization` or a small `ScoringConfig`).
- **Logic:** pure `scoreLead(lead, rules)` in `src/lib/lead-scoring.ts` (easy to unit-test with Vitest, which the repo already uses) called from the public endpoint and chat capture before write. Re-score on edit via a server action.
- **UI:** `/settings/scoring` rule editor (admin-only via `requireRole(role, "ADMIN")`); score badge + tier filter in the Leads Inbox.

**Effort:** **M.** Deps: **Idea 1** (writes score onto Lead); better with **4** (source as a signal). Predictive/AI scoring is explicitly **out of scope** for v1 (HubSpot gates it to higher tiers; needs training data Smart-CRM won't have early).

**Tier:** **Tier 2 (high-value).** Differentiator vs. plain form tools; turns capture into prioritized selling.

---

## Idea 6 — Deduplication on capture (merge into existing record)

**Description.** On every inbound, match by **email** (then optionally phone/domain) against existing `Lead`s and `Contact`s. If matched: update/enrich the existing record and append a new `FormSubmission` instead of creating a duplicate; otherwise create fresh. Configurable per form (HubSpot's "always create new" escape hatch). Plus a manual **merge** tool in the Leads Inbox for fuzzy duplicates.

**Competitor evidence.** HubSpot's dedup is "deeply embedded… cannot be turned off": a form submission matching an existing email **updates** that contact, and it also matches by cookie/user-token; the only override is an "Always create contact for new email address" toggle ([HubSpot dedup KB](https://knowledge.hubspot.com/crm-setup/deduplication-of-contacts-companies-deals-tickets), [HubSpot community: updates existing contact](https://community.hubspot.com/t5/CRM/when-i-submit-a-form-on-landing-page-its-update-an-existing/td-p/1188118), [Reform: prevent duplicate submissions](https://www.reform.app/blog/hubspot-form-settings-prevent-duplicate-submissions)). Without this, public forms quickly pollute the DB — the #1 complaint in form-tool support threads.

**Fit with Smart-CRM.**
- **Logic:** `findDuplicate({ orgId, email, phone })` in `src/lib/dedup.ts` using the **existing `@@index([orgId, email])` on Contact** (add the same on Lead). Pure-ish + DB lookup, unit-testable.
- **Endpoint behavior:** public route calls dedup before insert; on match, link the new `FormSubmission` to the existing `Lead`/`Contact` and merge non-empty fields (last-write-wins on conflict, mirroring HubSpot's "most recent overwrites"). Add per-`Form` `dedupMode` (MERGE | ALWAYS_NEW).
- **UI:** "Possible duplicate" badge + a Merge action (pick survivor, combine fields, reparent submissions/activities) in `/leads`.

**Effort:** **M** (auto-match S; manual merge UI adds M). Deps: **Ideas 1–2**. The merge transaction should reuse the `db.$transaction` style from `convertLead`.

**Tier:** **Tier 2 (high-value), trending Tier 1.** Data-quality guardrail; ship at least the email auto-match alongside the first public form.

---

## Idea 7 — Public Leads API (key-authenticated ingest endpoint)

**Description.** A documented REST endpoint, `POST /api/v1/leads`, authenticated by a per-org **API key**, so external systems (custom sites, Webflow/Framer, Zapier/Make, ad lead-form webhooks) can push leads straight into Smart-CRM. Same dedup + scoring + Lead creation as the in-app form. Foundation for an eventual public API.

**Competitor evidence.** This mirrors **Typeform's webhook → endpoint** model ("push form data to any endpoint in real-time"; "webhooks can be implemented to your lead distribution system for real-time delivery") and the way third parties wire HTML forms into Pipedrive via posted payloads/connectors ([Typeform webhooks](https://automationatlas.io/answers/typeform-review-2026/), [Pipedrive via LeadsBridge HTML form](https://leadsbridge.com/documentation/pipedrive/html-form/)). Every serious CRM exposes a lead-create API.

**Fit with Smart-CRM.**
- **Schema:** `ApiKey { id, orgId, name, hashedKey, lastUsedAt?, createdAt, revokedAt? }` (store a hash, show the secret once — same one-time-reveal pattern teams expect).
- **Route handler:** `src/app/api/v1/leads/route.ts` (`POST`) — read `Authorization: Bearer <key>`, look up by hash to resolve `orgId` (instead of `requireOrg()`'s session path), Zod-validate, dedup + score, create Lead, return `201` + lead id. Reuses the exact ingest core as Idea 2's form endpoint — extract a shared `ingestLead({ orgId, data, source })` helper in `src/server/leads/ingest.ts`.
- **UI:** `/settings/api-keys` to create/revoke keys (admin-only); a short docs snippet with a curl example.

**Effort:** **M.** Deps: **Idea 1** (and shares ingest core with **2**). Needs rate-limiting (**12**).

**Tier:** **Tier 2 (high-value).** Unlocks every no-code/3rd-party integration without per-tool work.

---

## Idea 8 — Live-chat + chatbot capture widget

**Description.** An embeddable chat widget (`<script>` loader → small bubble) running a **scripted playbook** (greeting → qualifying questions → capture name/email → create a Lead). Start bot-only (deterministic Q&A), with a clean path to **live takeover** by an online rep later. Each conversation persists as a `Lead` + transcript.

**Competitor evidence.** Pipedrive **LeadBooster Chatbot** uses **playbooks** of **cards** to "capture information, schedule meetings, or start a chat with a rep," and qualify/route to a sales team; **Live Chat** lets reps "seamlessly take over conversations started by a Chatbot" ([LeadBooster KB](https://support.pipedrive.com/en/article/leadbooster-add-on), [Pipedrive Chatbot](https://www.pipedrive.com/en/features/lead-generation-software/chat-bot), [Pipedrive Web Chat](https://www.pipedrive.com/en/features/web-chat)). Drift/Intercom playbook bots qualify and route similarly ([Drift playbooks](https://help.drift.com/article/product-guide---chat-playbooks/)). Conversational capture out-converts static forms ([WPForms forms vs conversational](https://wpforms.com/lead-forms-vs-conversational-forms/)).

**Fit with Smart-CRM.**
- **Schema:** `ChatPlaybook { id, orgId, name, steps Json, isActive }`; `Conversation { id, orgId, leadId?, status, startedAt }`; `Message { id, conversationId, role (BOT|VISITOR|AGENT), body, createdAt }`.
- **Public endpoints:** `src/app/api/public/chat/route.ts` for bot turns (stateless step-runner over `steps` JSON; creates Lead once email captured). Live takeover (phase 2) needs realtime — **note the repo has no websocket/SSE infra today**, so v1 is bot-only or SSE-polled; flag this dependency explicitly.
- **Widget:** a tiny self-contained bundle served from `/widget/chat.js` rendering an iframe to `/(public)/chat/[orgPublicId]`.
- **UI:** playbook editor + a chat console in-app to read transcripts/leads.

**Effort:** **L** (bot-only). Deps: **Idea 1**; live takeover adds realtime infra (extra L). Pairs with **5** (qualify) and **9** (book a meeting).

**Tier:** **Tier 3 (ambitious).** High-impact but the largest build; sequence after forms/leads/scoring prove the pipeline.

---

## Idea 9 — Meeting-scheduler card / "book a demo" capture

**Description.** A scheduling step usable inside forms and the chat widget: a qualified visitor picks an available slot, which captures the Lead **and** creates a follow-up `Activity` (type `MEETING`) on the assigned owner's calendar. Removes the email back-and-forth and converts intent at its peak.

**Competitor evidence.** Pipedrive chatbot playbooks **schedule meetings on reps' calendars** as a built-in card; Drift bots present slots so prospects "book a demo in real time"; Intercom books meetings via its calendar app ([LeadBooster KB](https://support.pipedrive.com/en/article/leadbooster-add-on), [Pipedrive Chatbot](https://www.pipedrive.com/en/features/lead-generation-software/chat-bot), [Drift playbooks](https://help.drift.com/article/product-guide---chat-playbooks/)). Booking at the moment of intent is a defining LeadBooster/Drift capability.

**Fit with Smart-CRM.**
- **Leverage existing `Activity` model** (already `type MEETING`, `dueAt`, `ownerId`, `contactId`) — convert/create Lead, then create an `Activity` for the slot. Minimal new schema: per-user `availability` (weekly windows) + simple slot generation; full calendar sync (Google) is a later add.
- **Endpoint:** extend the public form/chat ingest to accept a chosen slot; create Lead + Activity in one `db.$transaction`.
- **UI:** availability settings per user; slot picker component reused by form and chat.

**Effort:** **M** (internal availability only). Deps: **Idea 1**; real value with **8**; external calendar sync is a separate L.

**Tier:** **Tier 3 (ambitious).** Strong conversion lever; depends on chat/forms maturing first.

---

## Idea 10 — Multi-step / progressive-profiling forms

**Description.** Upgrade the form renderer from single-page to **multi-step** (one or few questions per screen, progress bar) with **conditional logic** (show/skip steps by answer) and **progressive profiling** (for a known returning lead, hide already-captured fields and ask the *next* unknown one). Directly targets higher completion rates.

**Competitor evidence.** HubSpot **progressive profiling**: mark fields "hide if data previously captured," set a **priority order**, and returning contacts see the next unanswered question (Pro/Enterprise) ([HubSpot progressive profiling](https://www.hubspot.com/blog/bid/33993/hubspot-forms-now-feature-progressive-profiling-and-a-new-interface), [Webdew guide](https://www.webdew.com/blog/hubspot-progressive-form-fields)). Typeform **logic jumps** branch the flow by answer ([Typeform logic jumps](https://www.typeform.com/developers/create/logic-jumps/)). Conversion lift is large and well-documented: multi-step ~86% higher (HubSpot), 0.96%→8.1% (Venture Harbour), 13.9% vs 4.5% multi- vs single-page (Formstack) ([Digioh](https://www.digioh.com/blog/multi-step-forms), [Venture Harbour](https://ventureharbour.com/multi-step-lead-forms-get-300-conversions/)).

**Fit with Smart-CRM.**
- **Schema:** extend `Form.fields` JSON with `step` index + `showIf` condition per field; a `mode: SINGLE | MULTI` flag. Progressive profiling needs a returning-visitor token (cookie set by the embed) to look up the existing Lead and compute already-known fields.
- **Render:** evolve the `react-hook-form` renderer to page through steps and evaluate `showIf`; the public endpoint already accepts the merged payload.
- **Builder:** step grouping + simple condition rows in the form editor.

**Effort:** **M** (multi-step + logic); progressive profiling adds **M** (returning-visitor identity + field diffing, related to dedup). Deps: **Ideas 2** and **6**.

**Tier:** **Tier 3 (ambitious).** A conversion enhancement; ships after the basic form pipeline is solid.

---

## Idea 11 — Spam protection: honeypot + optional CAPTCHA

**Description.** Bake abuse defense into every public capture: a **honeypot** hidden field (silently drop submissions that fill it), basic heuristics (min time-to-submit, disposable-email block), and **optional reCAPTCHA/Turnstile** per form for aggressively targeted pages. Protects data quality and the (new) public endpoints.

**Competitor evidence.** Industry guidance: **honeypot first** — "a hidden field bots can't resist… real users won't even notice," zero friction; add **CAPTCHA** only as a heavier second layer for sophisticated/aggressive bots, since reCAPTCHA "is known to reduce form completions" ([Growform honeypot](https://www.growform.co/glossary/anti-spam-honeypot/), [Webflow honeypot](https://help.webflow.com/hc/en-us/articles/45025662151827-Use-the-honeypot-technique-to-filter-spam-form-submissions), [LeadCapture: prevent form spam](https://leadcapture.io/blog/prevent-form-spam/)). HubSpot users add honeypots to forms for the same reason ([HubSpot community honeypot](https://community.hubspot.com/t5/Lead-Capture-Tools/Add-honeypot-to-form-for-spam-protection/m-p/746921)).

**Fit with Smart-CRM.**
- **Logic:** honeypot + timing checks in the public route handlers (Ideas 2/7/8); reject silently with `200` so bots don't learn. Disposable-domain list in `src/lib/spam.ts`. Optional Turnstile/reCAPTCHA token verified server-side (env-keyed via `@t3-oss/env-nextjs`, which the repo uses for env validation).
- **Schema:** per-`Form` `captchaEnabled` flag.
- No UI beyond a toggle in the form editor + a hidden field in the renderer.

**Effort:** **S** (honeypot + heuristics); CAPTCHA adds **S** (env keys + verify call). Deps: **Ideas 2/7** (the endpoints it guards).

**Tier:** **Must-have / Tier 1** *for the public endpoints* — ship the honeypot in the same PR as the first public form; CAPTCHA can follow.

---

## Idea 12 — Rate limiting & abuse controls for public endpoints

**Description.** Per-IP and per-form/per-key rate limits on all public capture routes, plus payload-size caps and structured logging of rejects. Smart-CRM has **no** rate-limiting today, and these are its first unauthenticated write endpoints — without limits they're a spam/DoS and cost liability.

**Competitor evidence.** Not a marketed "feature" but universal operational practice for public lead endpoints; complements the spam guidance above ([LeadCapture: prevent form spam](https://leadcapture.io/blog/prevent-form-spam/)) and is implied by any "post to any endpoint" model like Typeform webhooks ([Typeform webhooks](https://automationatlas.io/answers/typeform-review-2026/)). Public form/API endpoints are a standard abuse target; every form SaaS throttles them.

**Fit with Smart-CRM.**
- **Logic:** a `rateLimit(key, limit, windowMs)` helper in `src/lib/rate-limit.ts`. The repo has **no Redis** today, so v1 can use an in-memory/LRU limiter (single-instance) or Postgres-backed counters; flag that durable limiting needs Upstash/Redis (a small infra add) for multi-instance/serverless deploys (relevant given Vercel hosting).
- **Apply** in the public route handlers (Ideas 2/7/8) keyed by IP + formId/apiKey; return `429` with `Retry-After`. Add payload-size guard and request logging.

**Effort:** **S** (in-memory) / **M** (durable Redis-backed). Deps: paired with **Ideas 2/7/8**; durable mode adds an infra dependency.

**Tier:** **Must-have / Tier 1** *for going live* with any public endpoint. Non-negotiable before exposing capture publicly.

---

## Summary table

| # | Idea | Effort | Key deps | Tier |
|---|------|--------|----------|------|
| 1 | `Lead` object + Leads Inbox | M | — | 1 Must-have |
| 2 | Form builder + `FormSubmission` + embeddable form | L | 1 | 1 Must-have |
| 3 | Hosted landing pages | M | 2 | 2 High-value |
| 4 | Source & UTM capture | S | 1, 2 | 1 Must-have |
| 5 | Rule-based lead scoring & qualification | M | 1 (4) | 2 High-value |
| 6 | Deduplication on capture + merge | M | 1, 2 | 2 High-value |
| 7 | Public Leads API (key auth) | M | 1 (shares core w/ 2), 12 | 2 High-value |
| 8 | Live-chat + chatbot widget | L | 1 (5, 9) | 3 Ambitious |
| 9 | Meeting-scheduler card | M | 1 (8) | 3 Ambitious |
| 10 | Multi-step / progressive-profiling forms | M | 2, 6 | 3 Ambitious |
| 11 | Spam protection (honeypot + CAPTCHA) | S | 2, 7 | 1 Must-have (for public) |
| 12 | Rate limiting & abuse controls | S/M | 2, 7, 8 | 1 Must-have (for public) |

**Suggested build order:** 1 → 2 (+11, +12, +4, + email-match slice of 6) → 5 → 3 → 7 → full 6 → 10 → 8 → 9. This delivers a safe, attributable, deduped form-to-Lead pipeline first, then scoring, then API/landing-page reach, then conversational capture.

---

## Top 3 picks

1. **`Lead` object + Leads Inbox (Idea 1)** — the foundational schema/screen everything else writes into; mirrors Pipedrive's Leads-Inbox-separate-from-deals model and is the prerequisite for forms, chat, scoring, and the public API. Effort M, no deps.

2. **Form builder + embeddable form + `FormSubmission` (Idea 2)** — the primary capture surface and Smart-CRM's first public write endpoint; directly mirrors HubSpot/Pipedrive embeddable forms. Ship with honeypot (11), rate-limiting (12), UTM capture (4), and email-dedup (6) in the same effort to launch safely.

3. **Rule-based lead scoring & qualification (Idea 5)** — turns raw capture into prioritized selling via fit + engagement rules and Cold/Warm/Hot tiers, mirroring HubSpot's manual scoring; the differentiator that elevates Smart-CRM from a form tool to a CRM. Effort M.
