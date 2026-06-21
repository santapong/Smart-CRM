# Smart-CRM Marketing Research — Integrations & Ecosystem

**Author:** Marketing Research (Integrations & ecosystem)
**Date:** 2026-06-20
**Scope:** WHICH integrations matter most for SMB CRM adoption + their go-to-market value. Native-vs-Zapier strategy, OAuth app model, marketplace. (The backend team owns the connector framework internals; this doc ranks demand and GTM value.)

---

## Executive summary

Integrations are not a "nice to have" for SMB CRM — they are a top adoption and retention lever. Pipedrive's own marketplace data shows **businesses that use integrations win ~1.5x more deals**, with a **47% average win ratio** and deals closing **~12% faster**; in 11 months **134,000+ users installed at least one app** ([Pipedrive newsroom](https://www.pipedrive.com/en/newsroom/pipedrive-marketplace-survey-businesses-leveraging-integrations-win-about-1-5-times-more-deals)). HubSpot has crossed **2,000+ apps and 2.5M+ active installs** ([HubSpot Community](https://community.hubspot.com/t5/Releases-and-Updates/2-000-Apps-2-5M-Active-Installs/ba-p/1209474)). Pipedrive ships **~300–400 native integrations** ([Outfunnel](https://outfunnel.com/best-pipedrive-crm-integrations/), [NUACOM](https://nuacom.com/best-pipedrive-integrations/)).

Across both leaders, the **most-demanded categories** are remarkably consistent: **(1) email + calendar sync, (2) communication/messaging (Slack), (3) phone/calling (Aircall/Twilio/JustCall), (4) marketing automation, (5) finance/invoicing (QuickBooks/Xero), (6) document/e-signature, (7) automation platforms (Zapier/Make)** ([Pipedrive support](https://support.pipedrive.com/en/article/pipedrive-marketplace-apps-integrations), HubSpot "Essential Apps for Sales").

**Strategic recommendation for Smart-CRM:** pursue a **"native core, long-tail via Zapier"** model. Build deeply native the few integrations that sit on the daily critical path (email/calendar sync, Slack, click-to-call) where quality is the product. Cover the long tail (hundreds of niche apps) via **Zapier/Make + a public API + webhooks** rather than hand-building connectors. This is exactly how Pipedrive positions itself: ~400 native tools *and* "built to play well with Zapier" ([Zapier comparison](https://zapier.com/blog/pipedrive-vs-hubspot/)).

The repo is **well-positioned**: NextAuth's `Account` model already stores `access_token`, `refresh_token`, `expires_at`, and `scope` per provider — the OAuth plumbing for Google/Microsoft/Slack already exists conceptually (`prisma/schema.prisma:28-45`). The gaps are: no per-org token storage (Account is per-User), no sync-state/external-ID mapping tables, no webhook outbox, no public API tokens. These are small, well-understood additions.

### Build-vs-buy posture (the meta-decision)
- **Email/calendar sync** is deceptively hard: Gmail (REST + quotas), Outlook (Graph/EWS), and IMAP each have different auth and edge cases ([Unipile](https://www.unipile.com/email-api-providers/), [Nylas](https://www.nylas.com/products/email-api/)). A **unified API (Nylas / Unipile / Aurinko)** gives you the "pipe" so you build only the CRM mapping "pump" ([Nylas guide](https://zeeg.me/en/blog/post/nylas-api)). Recommend **buy the sync layer, build the CRM logic** for v1, with an eye to bringing it native later for margin.
- **Long-tail SaaS connectors:** don't hand-build. Use **Zapier/Make** for non-technical reach; consider an **embedded unified API (Nango code-first, or Merge.dev store-and-sync)** only once you're building many native CRM↔SaaS syncs ([Nango vs Merge](https://nango.dev/blog/merge-dev-vs-nango/)). Nango fits a code-first Next.js/TS shop; Merge fits "many CRMs, normalized schema, fast."
- **Telephony:** Twilio = build-your-own dialer (developer toolkit); Aircall/JustCall = partner/embed (turnkey) ([CloudTalk](https://www.cloudtalk.io/blog/click-to-call-providers/)). Start with a **partner embed + Zapier**, not a from-scratch Twilio dialer.

---

## Ranked integration ideas

Each: (1) name + desc, (2) competitor/market evidence & demand, (3) fit with Smart-CRM, (4) Effort + deps, (5) tier.

Effort key: **S** = days–1 sprint, **M** = 1–2 sprints, **L** = multi-sprint/quarter.
Tier key: **Quick Win** (fast, high adoption-per-effort) · **Core** (table-stakes platform capability) · **Strategic Bet** (ecosystem/moat play, larger investment).

---

### 1. Two-way Email Sync (Gmail + Outlook) — **#1 priority**
**Desc:** Connect a rep's Gmail/Outlook so emails to/from contacts are auto-logged on the contact and deal timeline; send tracked email from inside Smart-CRM. Two-way sync.

**Evidence & demand:** This is the single most-cited "table-stakes" CRM integration. Pipedrive logs every message to the right contact and deal automatically; HubSpot offers two-way Gmail/Outlook/IMAP with auto-logging of replies ([Outfunnel](https://outfunnel.com/best-pipedrive-crm-integrations/), [folk comparison](https://www.folk.app/articles/HubSpot-vs-Pipedrive-email-integration)). Email is consistently the feature buyers compare CRMs on. Without it, reps live in their inbox and the CRM data goes stale — the #1 cause of SMB CRM abandonment.

**Fit with Smart-CRM:** **Build native, buy the sync layer.** OAuth via NextAuth `Account` (Google/Microsoft providers) — tokens, scope, refresh already modeled (`schema.prisma:28-45`). Need: an `EmailMessage`/`SyncedEmail` model linked to `Contact`/`Deal` by matched email address (Contact already indexes `[orgId, email]`, `schema.prisma:140`), plus a `MailboxConnection` (per-Membership, not per-User, for org scoping) with sync cursor. Recommend **Nylas/Unipile/Aurinko** for the provider abstraction in v1 ([Nylas](https://www.nylas.com/products/email-api/)) — "they give the pipe, you build the pump" ([Nylas guide](https://zeeg.me/en/blog/post/nylas-api)). Server actions to send; background job/webhook to ingest.

**Effort:** **L** — deps: unified email API account, background worker/queue, new sync + message-store models, OAuth scope expansion. The hardest item but the highest ROI.

**Tier:** **Core** (the cornerstone of the whole integrations strategy).

---

### 2. Calendar Sync (Google + Microsoft) — **#2 priority**
**Desc:** Two-way sync between rep calendars and Smart-CRM Activities (type `MEETING`). Meetings booked anywhere show on the contact timeline; meetings created in CRM appear on Google/Microsoft calendar with guest invites.

**Evidence & demand:** Native Google/Office 365 calendar sync is standard in both leaders; HubSpot's scheduler "updates Google Calendar or Office 365… complete with automatic guest invites and timeline entries" ([search summary](https://outfunnel.com/best-pipedrive-crm-integrations/)). Pairs with email as the daily-driver duo. Calendar APIs are comparatively well-trodden (Cronofy/Nylas) ([Cronofy](https://www.cronofy.com/blog/best-calendar-apis)).

**Fit with Smart-CRM:** **Build native.** The `Activity` model already has `MEETING` type and `dueAt` (`schema.prisma:212-240`) — map calendar events ↔ Activities with an `externalId`/`provider` field. Reuses the same OAuth `Account` tokens as email (often the same Google/Microsoft consent), so incremental once #1 exists. Can use the same unified provider (Nylas/Cronofy do calendar too).

**Effort:** **M** (drops to **S–M** if shipped alongside #1 sharing OAuth + provider). Deps: #1's connection model + scopes, an `externalId` on Activity.

**Tier:** **Core.**

---

### 3. Slack Notifications & Deal Alerts — **highest adoption-per-effort**
**Desc:** Push real-time CRM events to Slack channels/DMs: deal won/lost, deal moved stage, new lead assigned, task due, @mentions. Optional slash commands / "create note from Slack."

**Evidence & demand:** Messaging/communication is **the #1 popular Pipedrive Marketplace category** ([search summary, Pipedrive support](https://support.pipedrive.com/en/article/pipedrive-marketplace-popular-categories)); Slack is a featured "Essential App for Sales" in HubSpot. Salesforce frames Slack as shortening SMB sales cycles via real-time alerts — "the difference between a 5-minute and a 5-hour response time can decide a deal" ([Salesforce SMB blog](https://www.salesforce.com/blog/small-business/slack-and-crm-for-smb-sales/), [Momentum buyer's guide](https://www.momentum.io/blog/the-best-tools-for-sales-deal-updates-via-slack-integration-2025-buyers-guide)). Pipedrive ships a first-party Slack integration ([Pipedrive Slack](https://www.pipedrive.com/en/features/slack-crm-integration)).

**Fit with Smart-CRM:** **Build native — easiest high-value win.** Slack OAuth slots into the `Account` model; store the org's incoming-webhook/bot token (per-Organization). Emit from existing server actions (deal stage change, win/loss already modeled via `DealStatus`, `schema.prisma:179-210`). One-directional outbound first (trivial), bidirectional later. This is the **best Quick Win**: huge perceived value, small surface, demos beautifully.

**Effort:** **S–M.** Deps: Slack OAuth app, an `OrgIntegration`/token table, an event-emit hook in server actions (a webhook outbox helps but isn't required for v1).

**Tier:** **Quick Win.**

---

### 4. Zapier Integration (public app) — **the long-tail multiplier**
**Desc:** Official Smart-CRM app on Zapier: triggers (new/updated contact, deal stage change, deal won, new activity) + actions (create/update contact, create deal, log activity). Instantly connects Smart-CRM to **8,000+ apps** without building any of them.

**Evidence & demand:** Zapier is the "glue that automates a CRM" and the standard SMB no-code layer; Pipedrive is explicitly "built to play well with Zapier" ([Zapier comparison](https://zapier.com/blog/pipedrive-vs-hubspot/), [Nutshell](https://www.nutshell.com/blog/best-crms-for-zapier)). Real SMB impact: "an 8-person team built 47 Zaps saving 12 hours/week" ([UI Bakery](https://uibakery.io/blog/what-is-zapier)). For a young CRM, a Zapier app is the **cheapest way to claim "thousands of integrations"** in marketing copy.

**Fit with Smart-CRM:** **Requires a public API + webhooks first** (see #8), then the Zapier app is mostly config. Triggers map cleanly to existing entities (Contact/Deal/Activity). This is the strategic complement to native: native for the daily-driver few, Zapier for the long tail. **Make** is the natural fast-follow (same API).

**Effort:** **M** (assuming #8 exists; **S** for the Zapier app layer itself). Deps: **public REST API + API-key auth + outbound webhooks (#8)**.

**Tier:** **Strategic Bet** (it's the leverage point that makes the whole long-tail strategy work).

---

### 5. Public REST API + Webhooks + API tokens — **the platform foundation**
**Desc:** Documented REST API over core objects (contacts, companies, deals, activities, pipeline) with per-org API keys, rate limits, and **outbound webhooks** (create/update/delete events). The substrate for Zapier, Make, custom apps, and eventually a marketplace.

**Evidence & demand:** Every serious CRM exposes a REST/JSON API with OAuth and webhooks; modern CRMs favor **webhooks for critical events (deal created) + polling for bulk** ([breakcold](https://www.breakcold.com/blog/best-crms-with-developer-api), [Codeless](https://www.codelessplatforms.com/webhook-vs-api-for-crm-integration/)). Pipedrive markets its "open API and Developer Platform" as a core selling point ([Pipedrive CRM API](https://www.pipedrive.com/en/features/crm-api)). Without an API, *no* third-party ecosystem (including Zapier) is possible.

**Fit with Smart-CRM:** **Build native** under `src/app/api/` (Next.js route handlers). Add `ApiToken` (hashed, per-Organization, scoped) and a `WebhookEndpoint` + `WebhookDelivery` outbox (for retries) to the schema. Reuse existing tenant scoping + RBAC. Zod schemas already in the stack make request validation cheap. This unblocks #4 (Zapier), #6 (Make), and a future marketplace.

**Effort:** **L** (API surface + auth + webhook delivery/retry + docs). Highest-leverage infrastructure item; *backend owns the framework, but GTM value is "we're a platform, not a silo."*

**Tier:** **Strategic Bet.**

---

### 6. Click-to-Call + Call Logging (Aircall / JustCall / Twilio) — telephony
**Desc:** Click a contact's phone number to dial; auto-log call (duration, recording link, notes) as a `CALL` activity. Inbound calls pop the matching contact ("screen pop"). SMS optional.

**Evidence & demand:** Phone/calling is a **top-3 Pipedrive Marketplace category** ([Pipedrive support](https://support.pipedrive.com/en/article/pipedrive-marketplace-popular-categories)); Aircall/JustCall integrate with Pipedrive/HubSpot/Salesforce/Zoho and are HubSpot "Essential Apps." Hard SMB number: **62% of SMB calls go unanswered, 80% skip voicemail, 85% never call back — ~$126k/yr lost** ([CloudTalk](https://www.cloudtalk.io/blog/click-to-call-providers/)). Strong demand among phone-heavy SMB verticals (agencies, real estate, home services).

**Fit with Smart-CRM:** **Partner-embed + Zapier first, not a from-scratch Twilio dialer.** `Contact.phone` and `Activity` type `CALL` already exist (`schema.prisma:127`, `212-217`). Start with **Aircall/JustCall** turnkey embed (their widget + webhook → create CALL activity) for fast value; Twilio only if you want to build a native dialer later (it's a "build from scratch" developer toolkit, [CloudTalk](https://www.cloudtalk.io/blog/click-to-call-providers/)). Inbound screen-pop needs the webhook ingest + contact lookup by phone.

**Effort:** **M** (partner embed + webhook ingest). **L** if building native Twilio dialer. Deps: webhook ingest endpoint, possibly #5.

**Tier:** **Core** (for telephony-heavy SMB segments) — sequence after the email/Slack/API core.

---

### 7. Accounting Sync — QuickBooks Online + Xero (sales-to-cash)
**Desc:** When a deal is **Won**, push the customer + create a draft invoice/estimate in QuickBooks/Xero; sync payment status back so reps see "Paid/Overdue" on the deal. One-click "create invoice from deal."

**Evidence & demand:** Finance/invoicing is a recognized Pipedrive Marketplace category (QuickBooks, Xero) ([NUACOM](https://nuacom.com/best-pipedrive-integrations/)). OnePageCRM creates draft Xero invoices from the CRM with contact + deal value prefilled ([OnePageCRM](https://www.onepagecrm.com/marketplace/apps/xero/)); Method CRM's whole pitch is real-time two-way QuickBooks/Xero sync of customers, invoices, payments ([Method](https://www.method.me/)). Closes the **sales-to-cash loop** SMBs care about and reduces double data entry.

**Fit with Smart-CRM:** **Build native (OAuth)** *or* **start via Zapier** (QuickBooks/Xero are among the most-used Zapier apps, [CloudTalk](https://www.cloudtalk.io/blog/best-zapier-integrations/)). OAuth tokens fit `Account`. Map `Deal` (has `value`, `currency`, `status=WON`, `schema.prisma:185-210`) + `Company`/`Contact` → invoice. Recommend **Zapier path first** (validate demand cheaply), promote to **native** for the QuickBooks crowd once #5 exists.

**Effort:** **M** native (two OAuth integrations + invoice mapping + status webhooks); **S** via Zapier. Deps: #5 helps; OAuth scopes.

**Tier:** **Core** (sequence after the daily-driver set; strong for service/B2B SMBs that invoice).

---

### 8. Lead Capture: Web Forms + Scheduling (Calendly) — top-of-funnel
**Desc:** Embeddable Smart-CRM web form that creates a contact + deal on submit; plus a **Calendly** integration that creates/updates a contact and logs a `MEETING` activity when a prospect books.

**Evidence & demand:** Lead generation is a **top Pipedrive Marketplace category** ([search summary](https://support.pipedrive.com/en/article/pipedrive-marketplace-popular-categories)). Calendly is a flagship HubSpot scheduling integration — "creates new leads/contacts once a meeting is scheduled, and updates activities" ([Calendly+HubSpot](https://calendly.com/integration/hubspot), [Outfunnel](https://support.outfunnel.com/en/articles/5741443-how-to-set-up-a-connection-between-calendly-and-your-crm)). Chat-widget lead capture that auto-creates CRM records is a common SMB feature ([SMBcrm](https://smbcrm.com/features/lead-capture/)). Fills Smart-CRM's biggest funnel gap: **leads currently only enter by manual entry.**

**Fit with Smart-CRM:** **Native web form** (own it; just a public route + server action creating Contact/Deal) is a genuine **Quick Win** and a great wedge. **Calendly** via its webhook → create/update Contact + `MEETING` Activity (maps to existing models). No new heavy infra for the form; Calendly needs a webhook ingest (shares #6's machinery).

**Effort:** **S** (native web form) / **M** (Calendly webhook). Deps: a public form route; webhook ingest for Calendly.

**Tier:** **Quick Win** (the native form especially).

---

### 9. E-Signature — DocuSign / PandaDoc (close the deal)
**Desc:** Generate a quote/contract from a deal, send for signature, and flip the deal to **Won** + log the signed doc when it's completed.

**Evidence & demand:** Document/e-sign is a standard marketplace category; DocuSign is a HubSpot "Essential App" ("no deal left unsigned"). PandaDoc integrates with Salesforce, Pipedrive, HubSpot, Zoho, Copper and is positioned for **agile SMB sales teams** at lower cost; DocuSign skews enterprise/legal ([Proposify](https://www.proposify.com/blog/pandadoc-vs-docusign), [Vendr](https://www.vendr.com/blog/pandadoc-vs-docusign-compared)). Directly accelerates deal close — a metric SMBs feel.

**Fit with Smart-CRM:** **Via Zapier first, then native PandaDoc.** PandaDoc fits the SMB ICP better than DocuSign. On signature-complete webhook, set `Deal.status = WON` and attach the doc. Needs document storage/links (new lightweight model) — heavier than the form, lighter than email sync.

**Effort:** **M** (native PandaDoc + doc-status webhook); **S** via Zapier. Deps: webhook ingest, deal-update action, doc link storage.

**Tier:** **Core** (but sequence behind email/calendar/Slack/API — it's a fast-follow once the platform exists).

---

### 10. Email Marketing Sync — Mailchimp / Brevo / ActiveCampaign
**Desc:** Two-way contact sync between Smart-CRM and an email marketing tool; sync tags/segments and surface campaign engagement (opens/clicks) on the contact.

**Evidence & demand:** Marketing automation/email is a **top-3 Pipedrive Marketplace category**; Pipedrive lists Mailchimp, ActiveCampaign, Brevo, Klaviyo, MailerLite, Constant Contact ([search summary](https://outfunnel.com/best-pipedrive-crm-integrations/), [Pipedrive support](https://support.pipedrive.com/en/article/pipedrive-marketplace-apps-integrations)). Mailchimp is among the most-used Zapier apps ([UI Bakery](https://uibakery.io/blog/what-is-zapier)). High demand, but for a small team it's mostly **contact list sync** — a great Zapier candidate rather than a bespoke build.

**Fit with Smart-CRM:** **Via Zapier/Make** to start (contact create/update/tag triggers map to existing `Contact`/`Tag` + `ContactTag` models, `schema.prisma:143-163`). Promote one (likely **Mailchimp** or **Brevo** for SMB) to native only if data shows pull. Don't hand-build all six.

**Effort:** **S** via Zapier; **M** native per provider. Deps: #4/#5.

**Tier:** **Quick Win** (through Zapier) — minimal effort, checks a high-demand box.

---

### 11. Integrations Directory / Marketplace (in-app) — ecosystem surface
**Desc:** An in-app **Integrations** page: browse/connect available integrations (OAuth connect buttons, status, per-org config), plus a public marketing page. Later, a partner-listed marketplace.

**Evidence & demand:** Marketplaces are how CRMs present and monetize ecosystems and drive distribution (Salesforce AppExchange, Pipedrive Marketplace, HubSpot's 2,000+ apps) ([HubSpot Community](https://community.hubspot.com/t5/Releases-and-Updates/2-000-Apps-2-5M-Active-Installs/ba-p/1209474)). Pipedrive's "win 1.5x more deals with integrations" stat is itself a **marketplace marketing asset** ([Pipedrive newsroom](https://www.pipedrive.com/en/newsroom/pipedrive-marketplace-survey-businesses-leveraging-integrations-win-about-1-5-times-more-deals)). Even a simple connect-page makes integrations **discoverable** — undiscovered integrations don't drive adoption.

**Fit with Smart-CRM:** **Build native UI** (`src/app/.../integrations` + shadcn cards). Backed by an `OrgIntegration` table (provider, status, scopes, config) — the same table Slack/email/calendar already need. Start as a simple connections dashboard (v1), evolve into a third-party marketplace (with #5 + OAuth-app model) later (v2/v3).

**Effort:** **S** (v1 connections dashboard) → **L** (true third-party marketplace with partner apps + review). Deps: `OrgIntegration` table; long-term #5 + OAuth-app model.

**Tier:** **Quick Win** (the v1 dashboard) → **Strategic Bet** (the true marketplace).

---

### 12. OAuth App Model (Smart-CRM as an OAuth provider) — developer ecosystem
**Desc:** Let third-party developers register apps, do OAuth against Smart-CRM, and call the API on a user's behalf with scoped consent — the foundation for a real app marketplace (vs. just API keys).

**Evidence & demand:** This is how Pipedrive/HubSpot/HighLevel run public app ecosystems: register an app, OAuth 2.0, scopes, public listing page ([HighLevel marketplace](https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp/), [Pipedrive dev platform](https://www.pipedrive.com/en/features/crm-api)). It's what upgrades "we have an API" into "we have a platform." But it's only worth it **after** there's developer demand and a marketplace to populate.

**Fit with Smart-CRM:** **Build native, later.** Add `OAuthApp` + `OAuthGrant`/authorization-code tables; reuse the existing scoping/RBAC. Heavier than API keys (#5) and only valuable once #5 + #11 exist and partners want in. Clear **moat/Strategic Bet**, but explicitly **phase 3**.

**Effort:** **L.** Deps: #5 (public API), #11 (marketplace), security review.

**Tier:** **Strategic Bet** (long-horizon; don't start until #5/#11 land).

---

### 13. Data Enrichment — Apollo / Clearbit (Breeze) / Clay
**Desc:** Auto-enrich contacts/companies from a domain or email: job title, company size, industry, social, firmographics. "Enrich" button on a record.

**Evidence & demand:** Lead-gen/enrichment is a top Pipedrive Marketplace category. Apollo (230M+ contacts) is positioned as an SMB/mid-market stack-consolidator; Clay does waterfall enrichment across 150+ providers (lifts coverage 40%→78%); Clearbit is now HubSpot's native Breeze Intelligence ([Clay](https://www.clay.com/blog/crm-data-enrichment), [ZoomInfo](https://pipeline.zoominfo.com/sales/lead-enrichment-tools)). Real value but more "nice to have" for the smallest teams and can get pricey.

**Fit with Smart-CRM:** **Native button calling a provider API** (Apollo/Clearbit) — maps cleanly to empty fields on `Company` (`industry`, `size`, `domain`) and `Contact` (`title`) that already exist (`schema.prisma:102-141`). Per-org API key in `OrgIntegration`. A nice differentiator but **lower on the daily-critical-path** than email/Slack/phone.

**Effort:** **M** (one provider, field-mapping + UI). Deps: `OrgIntegration` table.

**Tier:** **Quick Win → Core** (good incremental once the connection framework exists; not first-wave).

---

### 14. Make (Integromat) Connector + iPaaS posture — long-tail #2
**Desc:** Publish a Smart-CRM app on **Make** alongside Zapier for visual, multi-step automations; keep an internal option for an **embedded unified API (Nango/Merge)** if/when many native CRM-to-CRM or SaaS syncs are needed.

**Evidence & demand:** Make is the standard #2 no-code platform after Zapier; Pipedrive lists both Zapier **and** Make as its automation category ([NUACOM](https://nuacom.com/best-pipedrive-integrations/)). For embedded native integrations at scale, **Nango (code-first, TS — fits this stack) vs Merge.dev (store-and-sync, normalized schemas)** is the build-vs-buy axis; CRM integrations are noted as *harder* than most categories because customers add custom fields/objects ([Nango vs Merge](https://nango.dev/blog/merge-dev-vs-nango/), [Nango CRM/ERP](https://nango.dev/blog/best-unified-api-for-crm-erp-integrations/)).

**Fit with Smart-CRM:** Make connector = same public API (#5) as Zapier, near-zero marginal cost. The **unified-API decision is an internal build-vs-buy** for *future* native connectors, not a v1 user feature — flag it so the team doesn't hand-roll dozens of connectors. Recommend **Nango** if integrations become core (code-first TS aligns with Next.js); **Merge** if breadth-fast matters more than control.

**Effort:** **S** (Make connector, given #5). **N/A** for the iPaaS decision (strategy note).

**Tier:** **Quick Win** (Make connector) + strategy guidance.

---

## Recommended sequencing (waves)

1. **Wave 1 — Daily-driver core + cheap wins:** #3 Slack (Quick Win), #8 native web form / Calendly (Quick Win), #1 Email sync (Core, start now — it's long), #2 Calendar sync (rides on #1's OAuth).
2. **Wave 2 — Platform foundation:** #5 Public API + webhooks → unlocks #4 Zapier, #14 Make, #10 Mailchimp/Brevo, #7 QuickBooks/Xero (via Zapier first), #11 v1 connections dashboard.
3. **Wave 3 — Verticalized depth + ecosystem moat:** #6 Telephony (Aircall/JustCall embed), #9 PandaDoc e-sign, #13 enrichment, then #11 true marketplace + #12 OAuth app model.

---

## Top 3 picks

1. **Two-way Email + Calendar Sync (Gmail/Outlook + Google/Microsoft)** — the #1 table-stakes pair; without it the CRM data goes stale and SMBs churn. Buy the sync layer (Nylas/Unipile/Aurinko), build the CRM mapping; OAuth already modeled in `Account`. *(Ideas #1 + #2.)*
2. **Slack notifications & deal alerts** — the single best adoption-per-effort win (#1 popular marketplace category, small surface, demos beautifully); emit from existing deal/stage server actions. *(Idea #3.)*
3. **Public API + Webhooks → Zapier app** — the leverage move: build the platform substrate once, then claim "8,000+ integrations" via Zapier/Make and unblock QuickBooks/Xero/Mailchimp/marketplace without hand-building each. *(Ideas #5 + #4.)*
