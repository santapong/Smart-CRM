# Marketing Research — Pricing, Packaging & Monetization

**Focus:** How to package and sell the new platform features, plus the in-app plumbing to enforce plans. Synthesized from competitor pricing research (HubSpot, Pipedrive, Zoho, Freshsales, Salesforce), June 2026.

---

## 1. Competitor price comparison (per seat/mo, annual billing)

| Product | Free tier | Entry paid | Mid | Top (SMB) | Seat min | Notes |
|---|---|---|---|---|---|---|
| **HubSpot Sales Hub** | Yes (2 paid-feature users) | Starter **$15** | Pro **$90** | Enterprise **$150** | None | Pro/Ent onboarding fees $1.5k/$3.5k; free View-Only seats; Starter Customer Platform bundle ~$15 |
| **Pipedrive** | No (14-day trial) | Lite **$14** | Growth **$39** / Premium **$59** | Ultimate **$79** | None | Add-ons: LeadBooster/Smart Docs/Projects ($32.50 etc.), bundled free on Premium/Ultimate |
| **Zoho CRM** | Yes (3 users) | Standard **$14** | Professional **$23** / Enterprise **$40** | Ultimate **$52** | None | AI (Zia) gated at Enterprise; very aggressive entry price |
| **Freshsales** | Yes (3 users, incl. phone/email/chat) | Growth **$9** | Pro **$39** | Enterprise **$59** | None | Telephony/WhatsApp usage-billed on top; Freddy Copilot $29 add-on |
| **Salesforce** | No | Starter **$25** | Pro Suite **$100** | (Ent $165+) | None | Starter barely customizable; real AI Enterprise+ |
| **Zoho Bigin** (SMB) | Yes (1 user) | Express **$7** | Premier **$12** | Bigin 360 **$18** | None | Lightweight pipeline CRM benchmark |

**Patterns:**
- **Free tier is the norm** (HubSpot, Zoho, Freshsales, Bigin) — only Pipedrive & Salesforce withhold it. A free plan is a strong acquisition wedge for an SMB CRM.
- **Entry paid clusters at $9–$15/seat.** The real revenue tier is the **mid plan ($23–$59)**, which unlocks email sync, automation, multiple pipelines, and reporting.
- **AI and advanced automation are the top-tier upsell levers** everywhere.
- **Annual saves ~20–35%** vs monthly across all vendors.
- **Add-ons** (Pipedrive) and **usage billing** (Freshsales telephony) supplement seat revenue.

---

## 2. Recommended Smart-CRM tier structure

A 4-tier ladder positioned to undercut Pipedrive while matching Zoho/Freshsales value, with a free wedge:

| Tier | Price (seat/mo, annual) | Target | Gated highlights | Key limits |
|---|---|---|---|---|
| **Free** | $0 (up to 3 users) | Solo / trial | Contacts, companies, 1 pipeline, activities, basic dashboard, ⌘K search | 1,000 contacts; 1 pipeline; 2 saved views; no email/automation |
| **Starter** | **$15** | Small teams | Everything in Free + multiple pipelines, custom fields, 2-way email + templates + tracking, web forms, CSV import, saved views, reminders | 3 pipelines; 25 custom fields; 1 mailbox/user; 5 automations |
| **Professional** | **$39** | Growing teams | + Workflow automation, sequences, products & line items, report builder + goals, lead scoring, scheduler, API + webhooks, audit log | 15 pipelines; unlimited custom fields; 150 automations; 3 mailboxes |
| **Business** | **$69** | Scaling / multi-team | + Teams & territories, fine-grained permissions, SSO/SAML, recurring revenue/MRR, Smart Docs + eSign, advanced security, priority support | Unlimited; SSO; sandboxes; higher API quota |

Plus optional **add-ons** (à la Pipedrive) for high-cost capabilities: **Lead-gen pack** (chatbot/prospector), **Telephony** (usage-billed via Twilio), **Email marketing/Campaigns** (priced by contact volume).

**Free plan strategy:** Generous enough to run a tiny team (mirrors Zoho/Freshsales 3-user free) but withholds email send, automation, and multi-pipeline — the exact features that drive the Starter→Pro upgrade.

---

## 3. Monetization plumbing — feature ideas

### A. Plan & entitlement model (Foundation)
- **Desc:** `Plan`, `Subscription`, and `Entitlement` records keyed to `Organization`; a `requireFeature(key)` / `withinLimit(key, n)` helper called from server actions.
- **Evidence:** Every competitor gates features by tier; standard SaaS pattern (Stripe entitlements).
- **Fit:** New models in `prisma/schema.prisma`; helpers alongside `src/lib/rbac.ts`/`tenant.ts`. See backend `19-billing-subscription`.
- **Effort:** M. **Deps:** none. **Tier:** Foundation.

### B. Stripe billing (Checkout + Billing Portal) + per-seat sync (Core)
- **Desc:** Stripe Checkout for signup/upgrade, Billing Portal for self-serve management; sync seat count to `Membership` count; idempotent webhooks for lifecycle.
- **Evidence:** All vendors per-seat; HubSpot removed seat minimums, free View-Only seats.
- **Fit:** Backend `19-billing-subscription` (Stripe flow + webhooks via jobs).
- **Effort:** L. **Deps:** webhooks/jobs. **Tier:** Core.

### C. Feature gating UI + upgrade prompts/paywalls (Core)
- **Desc:** Gated features show an inline "Upgrade to Professional" prompt instead of erroring; lock badges in nav; a pricing/billing settings page.
- **Evidence:** HubSpot/Zoho/Pipedrive all use in-app upgrade nudges as a growth lever.
- **Fit:** A `<FeatureGate feature="...">` wrapper component; billing page under `src/app/(app)/settings/`.
- **Effort:** M. **Deps:** entitlement model. **Tier:** Core.

### D. Plan limits + usage metering (Core)
- **Desc:** Enforce counts (contacts, pipelines, custom fields, automations, mailboxes) and meter usage (emails sent, automation runs) with soft warnings near the cap (Pipedrive-style "soft limits").
- **Evidence:** Pipedrive/Zoho publish per-tier numeric caps; soft limits prompt upgrades rather than hard-block.
- **Fit:** `withinLimit()` checks in create actions; a usage dashboard; Stripe meters for usage-billed add-ons.
- **Effort:** M. **Deps:** entitlement model, jobs (aggregation). **Tier:** Core.

### E. Add-on packaging (Quick Win → Core)
- **Desc:** Sell high-cost capabilities (lead-gen pack, telephony usage, email-marketing by contact volume) as separate line items, bundled free on the top tier (Pipedrive's proven model).
- **Evidence:** Pipedrive LeadBooster $32.50/co; Freshsales usage-billed telephony.
- **Fit:** Add-on entitlements + Stripe products.
- **Effort:** M. **Deps:** billing. **Tier:** Core.

### F. Free trial + freemium onboarding (Quick Win)
- **Desc:** 14-day Pro trial on signup (no card), downgrade to Free at expiry; trial countdown banner.
- **Evidence:** Universal 14-day trial; Zoho/Freshsales/HubSpot freemium funnels.
- **Fit:** Trial state on `Subscription`; banner component; tie to onboarding checklist (product `06`).
- **Effort:** S. **Deps:** entitlement model. **Tier:** Quick Win.

### G. Annual/monthly toggle + proration & dunning (Core)
- **Desc:** Annual (~20–30% discount) vs monthly; Stripe handles proration and failed-payment dunning.
- **Evidence:** All vendors discount annual ~20–35%.
- **Fit:** Stripe price IDs per interval; portal handles proration/dunning.
- **Effort:** S–M (mostly Stripe config). **Deps:** billing. **Tier:** Core.

---

## Top 3 picks
1. **Plan/Subscription/Entitlement model + `requireFeature`/`withinLimit`** — the foundation everything else gates on.
2. **Stripe Checkout + Billing Portal + per-seat sync** — turns the product into a business with minimal custom billing code.
3. **Feature gating UI + upgrade prompts** — converts the new platform features into upgrade revenue (the lever every competitor relies on).

## Recommended packaging summary
Lead with a **free 3-user plan**, monetize the **$39 Professional** tier (automation, sequences, reporting, products, API) as the volume revenue driver, reserve **teams/SSO/recurring-revenue/Smart-Docs** for **$69 Business**, and offer **add-ons** (lead-gen, telephony, email marketing) to capture high-cost usage — undercutting Pipedrive while matching Zoho/Freshsales feature value.
