# Smart-CRM — Feature Research: Index & Executive Synthesis

**Date:** 2026-06-20 · **Status:** RESEARCH / DESIGN ONLY (no code changed)

This directory holds the consolidated output of an Opus-only feature-research effort
across three teams — **Product** (6 agents), **Marketing/Growth** (9 agents), and
**Backend/Platform** (20 agents), **35 Opus agents in total**. Each team independently
audited Smart-CRM's current surface, benchmarked it against the leading SMB CRMs
(**HubSpot, Pipedrive, Zoho, Freshsales, Salesforce**, with Zoho Bigin as the low-end
reference), and produced one consolidated report. This document is the entry point: it
indexes the three reports, distills where they **converge**, and turns that convergence
into a single **ranked master list** and a **phased roadmap**.

**Objective.** Chart Smart-CRM's path from a clean-but-thin **single-tenant-shaped SMB
CRM** toward a **full CRM platform** — without losing the simplicity that is its wedge.
The strategic framing the teams agree on: stay **Pipedrive-simple on the sales core** while
becoming **HubSpot-broad on the few capabilities SMBs actually adopt** (email-on-the-record,
forms→leads, a linear no-code automation builder, funnel/source analytics), priced to
**undercut Pipedrive while matching Zoho/Freshsales value**, fronted by a generous free
tier, and differentiated by shipping **Claude-powered AI earlier and at a lower tier** than
any competitor gates it.

**The throughline.** All three teams arrive at the same structural insight from different
angles: Smart-CRM does not primarily need 200 features — it needs **a small set of shared
foundations**, after which most "features" become thin definitions on top. Product names
**custom fields** and a **stage-event log** as the keystones; Marketing names **email infra,
a lead object, and an automation engine** as the disqualifying gaps; Backend formalizes the
exact substrate: **background jobs, a domain event bus, a custom-fields engine, and an
entitlement model**. The roadmap below is organized around building those foundations first.

---

## Current state

Smart-CRM today is a **feature-complete MVP**: a clean, multi-tenant **Next.js 15** app
(App Router + RSC + server actions, **Prisma/Postgres 16**, **NextAuth v5**, Tailwind/shadcn).
Every business row carries `orgId`; every server action funnels through `requireOrg()`
(`src/lib/tenant.ts`) with optional `requireRole()` RBAC (OWNER>ADMIN>MEMBER), co-located
Zod validation, and a uniform `ActionResult` return. The shipped surface is **Contacts**
(tags + CSV export — the most advanced list page), **Companies**, **Deals** as a single
@dnd-kit **Kanban** (one pipeline per org), **Activities** (a flat TASK/CALL/MEETING/NOTE
list with create/toggle/delete but **no edit**), a hardcoded **Dashboard**, a global **⌘K**
palette (search-and-navigate only), and **Settings/RBAC**. It is a tidy **system of record**.

The **headline gaps** are consistent across all three reports and disqualifying in
head-to-head buyer evaluations: **no email** (1:1 or bulk), **no automation**, **no custom
fields**, **no multiple pipelines**, **no leads object**, **no web forms / lead capture**,
**no integrations or public API**, and **no billing/entitlements**. Beneath those: no
time-triggered job runner, no domain event bus, no stage-transition history (so funnel /
velocity / win-rate are uncomputable), no notifications, comments, calendar, or saved views.
In short — **there is no way for the outside world to enter the CRM and no way to act on the
data inside it.**

---

## The three team reports

| Report | Scope | Headline |
|---|---|---|
| [**Product features**](./product-features.md) | 6 product agents · Records, pipeline, activities/calendar, reporting, collaboration, onboarding/UX/search | **66 distinct features** mapped onto Smart-CRM's actual schema/action/UI patterns, tiered by effort + strategic value, with quick wins called out. |
| [**Marketing & growth**](./marketing-features.md) | 9 marketing agents · 3 competitor teardowns + email, lead capture, automation, integrations, analytics, pricing | **66-row gap table** vs competitors, plus positioning, a 4-tier pricing ladder, and the growth-surface build order (forms→leads→scoring→automation). |
| [**Backend & platform design**](./backend-design.md) | 20 backend agents · data model, multitenancy, RBAC, API, auth/SSO, integrations, events, search, notifications, storage, audit, jobs, email, automation, analytics, caching, realtime, import/export, billing, security | **~47 capabilities**, foundation-first, with Prisma sketches, library picks, a dependency graph, and the serverless constraints that shape every decision. |

---

## Top cross-cutting themes

The findings that surfaced **independently in two or three teams** — these are the load-bearing
investments, and they drive the roadmap:

- **Custom-fields engine** — named the **#1 gap by both Product and Marketing**, and a
  Backend Foundation. Registry + JSONB + dynamic Zod (no `ALTER TABLE` on serverless).
  The prerequisite for forms, scoring, reporting dimensions, validation, layouts, and
  custom objects. *Nothing else reaches full value without it.*
- **Async backbone: background jobs + a domain event bus** — Backend's two top Foundations
  (**Inngest** + a **transactional outbox**). Marketing tags nearly every growth feature
  `[backend: job runner / event bus]`; Product gates reminders, sequences, scheduled reports,
  and digests on "the cron runner that does not exist today." This is the single seam every
  consumer (webhooks, automation, notifications, analytics, email, sync) subscribes to.
- **Multiple pipelines + a Leads object** — flagged by all three as the two biggest
  *structural* gaps; both map cleanly onto the existing `PipelineStage`/`Deal` models and
  unblock honest win-rate metrics and a real lead lifecycle.
- **Email & comms** — 1:1 tracked email on the record (the flagship sales feature),
  templates, open/click tracking, suppression/compliance. Resend is pre-wired (`RESEND_API_KEY`
  already validated, unused); the `Activity` model is a ready home (`EMAIL` enum).
- **Lead capture + web forms** — Marketing's "single biggest missing growth surface" and
  Smart-CRM's **first public write endpoint**; ship with honeypot + rate-limit + UTM +
  dedup in the same effort.
- **Automation engine** — a **linear** no-code workflow builder (trigger→condition→action)
  riding the event bus, plus a recipe library. Converts the CRM from system-of-record to
  system-of-action; the biggest "feels like a real CRM" gap.
- **`DealStageEvent` stage-history log** — called out by Product, Marketing, **and** Backend
  as an **irreversible** gap: transitions are overwritten in place today, so funnel /
  velocity / time-in-stage are uncomputable retroactively. Cheap to add now, impossible to
  backfill later.
- **AI assistant (Claude-powered)** — the one clear *differentiator*: every competitor gates
  real AI behind top tiers/add-ons, so shipping drafting/summaries/NL-search **earlier and
  lower** is the moat.
- **Billing / entitlements** — `Plan`/`Subscription`/`Entitlement` + `requireFeature()` /
  `withinLimit()` + Stripe + a `<FeatureGate>`. A Backend Foundation and the paywall every
  monetizable feature enforces against.
- **Saved views + advanced filters** *(honorable mention)* — Product's #2: the daily-driver
  UX that moves Smart-CRM from "toy list" to platform, one engine reused across all objects.

---

## Ranked master feature list

The ~24 highest-impact items pulled from all three reports, ranked by **impact-vs-effort**
(foundations that unblock many features rank high even at L effort). **Team:** P=Product,
M=Marketing, B=Backend. **Effort:** S/M/L.

| # | Feature / Capability | Team(s) | Impact | Effort | Backend deps |
|---|---|---|---|---|---|
| 1 | **Background jobs / queue (Inngest)** | B | Critical — unblocks all async work | M | — (Foundation) |
| 2 | **Domain event bus (transactional outbox)** | B | Critical — the seam every consumer uses | M | jobs |
| 3 | **Custom-fields engine** (registry + JSONB + Zod) | P, M, B | Critical — #1 gap; foundation for forms/scoring/reports | L | — (Foundation) |
| 4 | **`DealStageEvent` history + DB-side aggregation** | P, M, B | High — irreversible if deferred; unlocks all funnel/velocity | S–M | — (Foundation) |
| 5 | **Entitlement/billing model + Stripe webhooks** | M, B | High — the paywall every tier enforces | M | Stripe webhooks |
| 6 | **Tenant-isolation extension + OCC + RBAC choke-point** | B | High — closes live leak/clobber/over-delete gaps | S–M | — (Foundation) |
| 7 | **Security trio** (rate limit + Sentry + dep/secret scan) | B | High — closes acute live risks, cheap | S–M | — (Foundation) |
| 8 | **Multiple pipelines** | P, M | High — top structural gap; mostly migration+backfill | M | — |
| 9 | **Saved & shared views + advanced filters** | P | High — daily-driver platform UX | M+L | — |
| 10 | **1:1 tracked email + templates + open/click** | P, M | High — flagship sales feature | M | email infra, jobs, webhook route |
| 11 | **Leads object + Lead Inbox + convert** | P, M | High — turns contact DB into a sales CRM | M–L | — |
| 12 | **Embeddable web forms → Lead** (honeypot/rate-limit/UTM/dedup) | M | High — first public path for prospects | L | public API, CORS, rate-limit |
| 13 | **No-code workflow automation + recipes** | M, B | High — system-of-record → system-of-action | L | event bus + jobs |
| 14 | **Record comments + @mentions** | P | High — top table-stakes collaboration gap | M+M | — |
| 15 | **In-app notification center** | P, B | High — mentions/assignments are worthless if unseen | M | notif model, events |
| 16 | **Calendar / agenda view + editable activities** | P | High — most visible missing surface; data already exists | M+S | — |
| 17 | **Guided CSV import + dedupe/merge** | P, B | High — #1 onboarding blocker; on-ramp for real data | L | jobs, storage |
| 18 | **Public REST API + keys/scopes + webhooks** | M, B | High — unlocks the integration ecosystem | M+L | API keys, events, queue |
| 19 | **Funnel + lead-source + velocity + win/loss analytics** | P, M | High — "where do deals stall / best customers come from" | M | DealStageEvent |
| 20 | **Rule-based lead scoring** | M | Med–High — raw capture → prioritized selling | M | custom fields |
| 21 | **Rotting indicators + win/loss reasons + weighted pipeline** | P, M | Med — cheap Pipedrive-signature quick wins | S–M | — |
| 22 | **Surface dark mode + onboarding checklist + empty states** | P | Med — credibility wins, ~0 schema | S | — |
| 23 | **Slack notifications & deal alerts** | M | Med — best adoption-per-effort integration | S–M | events |
| 24 | **AI assistant (Claude-powered)** | M | High (differentiator) — draft/summarize/score/NL-search | M–L | (rides on data + jobs) |
| 25 | **Products / line items + report builder + dashboards** | P, M, B | Med–High — revenue depth + reporting platform | L | custom fields, aggregation |

---

## Phased roadmap

The centerpiece. Dependency ordering is explicit: **Phase 1 foundations enable everything in
Phases 2–3.** Read the dependency rule as — *events* → webhooks/automation/notifications/analytics;
*jobs* → email/sync/imports/sequences/digests; *custom-fields* → forms/scoring/custom objects;
*entitlements* → all plan gating.

### Phase 1 — Foundations & Quick Wins

Build the four foundations the whole roadmap rests on, plus the cheap, high-fit product wins
that ship visible value while the platform work lands. The foundations are largely
**parallelizable** across the team.

**Must-do platform foundations**

| Item | Impact | Key dependency / shape |
|---|---|---|
| **Background jobs / queue (Inngest)** | Every async feature becomes reliable | Single `src/app/api/inngest/route.ts`; durable steps, retries, cron. No upstream dep. |
| **Domain event bus (transactional outbox)** | One seam all consumers subscribe to | `OutboxEvent` written in the *same* `$transaction` as the mutation; drained `FOR UPDATE SKIP LOCKED`. Dep: jobs. |
| **Custom-fields engine** | The #1 gap; unblocks forms/scoring/reports/layouts | `CustomFieldDefinition` registry + `customFields Json` + compile-defs-→-Zod. No upstream dep. |
| **Entitlement / billing model** | The paywall every tier enforces | `plans.ts` config + `Subscription` mirror + `getEntitlements()` gate composed with `requireOrg()`; idempotent Stripe webhooks. |
| **`DealStageEvent` history + DB-side aggregation** | Irreversible if deferred; unlocks all funnel/velocity | Fix `setDealStatus` to read before-state; append in `$transaction`; move dashboard math to `groupBy`. |
| **Tenant-isolation extension + OCC `version` + RBAC choke-point** | Closes live leak / silent-clobber / over-delete | Prisma `$extends` auto-injects `orgId`; `version` compare-and-swap; one `authorize()` choke-point. No new infra. |
| **Security trio** (rate limit + Sentry + dep/secret scan) | Closes the acute live risks (unthrottled `bcrypt` login) | `@upstash/ratelimit`, `@sentry/nextjs` (`sendDefaultPii:false`), Dependabot + secret scanning. |

**Cheap high-fit product wins** (little/no schema, no new infra)

| Item | Impact | Shape |
|---|---|---|
| **Multiple pipelines** | Top structural gap; unblocks per-pipeline probability/forecast/quotas | `Pipeline` model; `pipelineId` on `PipelineStage`+`Deal`; backfill "Default"; header `<Select>`. |
| **Rotting / stale-deal indicators** | Signature Pipedrive behavior, near-free | `rottingDays` on stage; pure `isRotting()` on `Deal.updatedAt`; red badge + filter on Kanban. |
| **Saved views / filters** | Daily-driver UX foundation | Generalize the `contacts/page.tsx` `where` into a typed filter DSL + `SavedView` rows; `<ViewSwitcher>`. |
| **Weighted pipeline (stage probability)** | Revenue thread; upgrades Kanban + dashboard | `probability` on stage + deal; weighted reducer; forecast widget by `closeDate`. |
| **Dark-mode toggle** | ~90% built, 0% reachable — pure credibility win | `next-themes` already installed; `.dark` palette already in `globals.css`; add `ThemeProvider` + toggle. |
| **Email verification / password reset** | Account trust + recovery; validates the email pipe | Resend + existing `VerificationToken`; transactional system emails. |
| **Quick wins bundle** | Visible value fast | Editable activities (`updateActivity`), leaderboard (`groupBy(['ownerId'])`), CSV export of reports, onboarding checklist, win/loss reasons. |

### Phase 2 — Core Platform

The table-stakes feature value, now buildable because the foundations exist. Each item below
is a **thin layer** on the Phase-1 seams.

| Item | Impact | Key schema / action / dependency |
|---|---|---|
| **Email infra + 1:1 tracked email** | Flagship sales feature — email logged on the timeline | `EmailMessage`/`EmailEvent`/`Suppression`; `sendContactEmail` via Resend; Svix-verified tracking webhooks. *Dep: jobs.* |
| **Leads object + web forms + capture** | Closes the #1 growth gap — prospects can enter the CRM | `Lead` + `convertLead()` txn; `Form`/`FormSubmission`; **public** ingest route + honeypot + rate-limit + UTM. *Dep: custom fields, public route.* |
| **Workflow automation engine** | System-of-record → system-of-action | `Workflow` JSON DAG + JSON-Logic conditions + `WorkflowRun`/`StepRun` memoized replay + recipe library. *Dep: events + jobs.* |
| **Reporting / report-builder + stage-event log** | Pipedrive-grade funnel/velocity/win-loss + saved reports | `Report.spec` JSON → whitelisted SQL compiler; funnel/velocity from `DealStageEvent`; recharts. *Dep: DealStageEvent + aggregation.* |
| **Public API + webhooks** | Unlocks the integration ecosystem | REST `/api/v1` + hashed `ApiKey`/scopes + cursor pagination; `WebhookEndpoint`/`Delivery` outbox + Standard-Webhooks HMAC. *Dep: events + queue.* |
| **Notifications** | Mentions/assignments/tasks surfaced; shared `AppHeader` also unblocks mobile | `Notification`/`NotificationDelivery` + prefs; generated off the outbox pipeline; poll-on-focus v1. *Dep: events.* |
| **Products / line items** | Revenue depth; `Deal.value` rolls up from items | `Product` + `DealLineItem`; value as cached sum recomputed in-txn. *Dep: custom fields helpful.* |
| **Sequences (cadences)** | Reusable timed multi-step follow-up; task steps create activities | `Sequence`/`Step`/`Enrollment {nextRunAt}`; cron advances; stop-on-reply/unsub. *Dep: jobs + email.* |
| **Lead / contact scoring** | Raw capture → prioritized selling (Cold/Warm/Hot) | `score` + `ScoringRule` (fit + engagement); pure `scoreLead()`. *Dep: custom fields.* |
| **Record comments + @mentions** | Top table-stakes collaboration gap | Polymorphic `Comment` + `Mention`; member-scoped autocomplete; `notify()` fan-out. *Dep: notifications.* |
| **Calendar / agenda + import infra** | Most visible missing surface + the on-ramp for real data | Client grid on `Activity.dueAt` + drag-to-reschedule; `ImportJob` Blob-upload + chunked parse + dedupe-upsert. *Dep: jobs + storage.* |

### Phase 3 — Strategic Bets

High value, heavier, sequenced last — gated behind the foundations **and** a real customer
pull.

| Item | Impact | Key dependency / shape |
|---|---|---|
| **Integrations marketplace** | Ecosystem moat; ~1.5× win-rate per Pipedrive data | Native core (Slack/Google) + long-tail via Zapier/Make over the public API; `Connection`/`SyncState`/`ExternalLink` + Nango substrate. *Dep: API + token vault + jobs.* |
| **SSO / SAML + SCIM** | Sells upmarket; enterprise deal-unblocker | **BoxyHQ Jackson** (OSS, native NextAuth provider) + `OrgDomain` binding + JIT provisioning. *Dep: social login.* |
| **Real-time collaboration** | Live Kanban/list/record sync, presence | Managed broker (Supabase Realtime / Pusher) publish-after-commit; `version` OCC; `/api/realtime/auth` validates `org:{orgId}:*`. *Dep: OCC + events.* |
| **Smart-Docs + eSign** | Quotes/proposals from line items; switching weapon | `Document`/`Template` + merge engine; public signed view; eSign via 3rd-party first. *Dep: products + file storage.* |
| **AI assistant (Claude-powered)** | The differentiator — shipped earlier/lower than rivals | Email draft/summarize, deal-risk summaries, scoring assist, NL search; strictly org-scoped behind the server boundary. *Dep: data + jobs.* |
| **Advanced RBAC / teams / territories** | Multi-team orgs; field-level + custom roles | CASL policy table → object-level choke-point → field/custom roles; `Team` closure table; `Territory`/`RecordShare`. *Dep: RBAC choke-point.* |
| **Recurring revenue / billing depth** | MRR/ARR; per-seat metering + dunning | Recurring `DealLineItem` → MRR/ARR; debounced seat-sync; Stripe Meters v2 + local `UsageCounter`. *Dep: products + billing foundation.* |
| **Marketing campaigns** | Bulk/broadcast email, A/B, nurture journeys, segments | `Campaign`/`CampaignRecipient` throttled to Resend 2 req/s; `Segment` dynamic lists; delay/wait nodes. *Dep: email + automation + jobs.* |

**Dependency ordering, restated.** Phase 1's four foundations (jobs, events, custom-fields,
entitlements) plus the cheap correctness/UX wins are the bedrock. Phase 2's email, leads/forms,
automation, reporting, API, and notifications are each *thin layers* on those seams. Phase 3's
strategic bets compound the platform — integrations and campaigns lean on the API + jobs + email
already built; SSO and advanced RBAC extend auth; AI rides on the data the earlier phases generate.
**Build the foundations once; serve the rest cheaply.**

---

## Methodology & caveats

- **35 Opus agents across 3 teams** produced this research: 6 Product, 9 Marketing,
  20 Backend. Each team consolidated multiple focus-area briefs into one report; this README
  is the cross-team synthesis layered on top.
- **Research-only.** No application code was changed. Prisma sketches, library picks, and
  schema/action names in the reports are *design proposals*, not implemented work. The only
  file written by this effort is this directory's set of Markdown reports.
- **Competitor facts need re-verification.** Pricing and feature/tier claims were gathered via
  **web research in mid-2025/2026** and should be **re-checked against live vendor pages before
  any external/customer-facing use** — vendor pricing and packaging move quarterly. As a
  concrete example, **Pipedrive renamed/restructured its tiers (the old 5-tier lineup is now
  presented as 4)**, and entry prices drift; treat every dollar figure and "gated to tier X"
  statement here as a **snapshot, not a quote**.
- **Effort tiers are relative** (S ≈ days–1 sprint, M ≈ 1–2 sprints, L ≈ multi-sprint/quarter)
  and assume the existing stack and conventions. They are sizing aids for sequencing, not
  estimates.
- **Serverless constraints shaped every backend decision** (no always-on worker, ~300–800s
  execution ceiling, pooled-connection limits, 4.5 MB body cap, cron-as-trigger). Designs that
  look unusual (HTTP-invoked jobs, outbox-as-queue, presigned uploads) follow directly from
  those constraints; see [`backend-design.md`](./backend-design.md) for the full reasoning.
