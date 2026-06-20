# Marketing Research — Competitor Teardown: Zoho CRM, Freshsales & Salesforce (Starter/Pro)

**Focus:** Standout features across Zoho CRM, Freshsales (Freshworks), and Salesforce Starter/Pro Suite that Smart-CRM lacks. Marked **[Table-stakes]** (present in all three / expected of any CRM) vs **[Differentiator]** (a standout worth copying selectively). Synthesized from deep-dive research of each vendor's docs/pricing, June 2026.

**Tier context (per seat/mo, annual):**
- **Zoho CRM:** Free (3 users) / Standard $14 / Professional $23 / Enterprise $40 / Ultimate $52. (Bigin SMB line: Free / $7 / $12 / $18.) AI (Zia) gates at Enterprise.
- **Freshsales:** Free (3 users, incl. built-in phone/email/chat) / Growth $9 / Pro $39 / Enterprise $59. Pro is the real workhorse (AI scoring, sequences, multi-pipeline).
- **Salesforce:** Starter Suite $25 / Pro Suite $100. Starter has almost no customization; Pro unlocks flows/custom objects/AppExchange (with tight caps); real Einstein AI is Enterprise+.

---

## Feature gaps worth adopting

### 1. Lead/contact scoring — rule-based then predictive [Table-stakes]
- **Who/how:** Zoho **scoring rules** (Pro) + Zia predictive scores (Enterprise); Freshsales rule-based scoring (Growth) + Freddy predictive (Pro); Salesforce predictive lead scoring (Enterprise+).
- **Fit:** Add a `score` field + `ScoringRule` model (field/engagement → points), computed on contact/lead changes via the automation engine. Predictive variant later.
- **Effort:** M. **Deps:** automation/events. **Tier:** Core.

### 2. Workflow automation rules [Table-stakes]
- **Who/how:** Zoho workflow rules (Std+, webhooks/functions Pro+); Freshsales workflows (Growth, 20/50/100 caps); Salesforce Flow Builder (Pro, ~5 flows/org cap).
- **Fit:** See backend `14-workflow-automation-engine`. Universal expectation.
- **Effort:** L. **Deps:** events + jobs. **Tier:** Core.

### 3. Custom fields & custom objects/modules [Table-stakes]
- **Who/how:** Zoho custom fields (Std) + custom modules (Pro, counts scale); Freshsales custom fields (Growth) + modules (Enterprise); Salesforce custom objects (Pro, ~50 cap).
- **Fit:** See backend `01-data-model-evolution`. Foundation for many features.
- **Effort:** L. **Deps:** none. **Tier:** Core (fields) → Strategic (objects).

### 4. Built-in telephony / click-to-call [Differentiator — Freshsales]
- **Who/how:** Freshsales ships **Freshcaller** (dialer Free, recording Growth, buy numbers in 90+ countries, pay-as-you-go minutes); Zoho **PhoneBridge** connects 100+ providers (Twilio/RingCentral/Aircall); Salesforce Sales Dialer is a paid add-on.
- **Why it matters:** Calls logged automatically against records; major SMB workflow.
- **Fit:** Integration via Twilio/Aircall connector (integrations framework); log calls as `Activity` (type CALL). Start with click-to-call + logging.
- **Effort:** M–L. **Deps:** integrations framework. **Tier:** Strategic Bet.

### 5. Built-in email: 2-way sync, templates, tracking, mass send [Table-stakes]
- **Who/how:** All three. Freshsales' Free tier already includes 2-way sync + templates + bulk; Zoho **SalesInbox** (Pro) prioritizes inbox by pipeline.
- **Fit:** See marketing `04-email-marketing` + backend `13-email-infrastructure`.
- **Effort:** L. **Deps:** email infra. **Tier:** Core.

### 6. Sales sequences / cadences [Table-stakes]
- **Who/how:** Zoho **Cadences** (Enterprise); Freshsales **Sales Sequences** (Pro, 10/25 per user); Salesforce Sales Engagement (Performance+/add-on).
- **Fit:** `Sequence` models + jobs scheduler. Builds on email + activities.
- **Effort:** M–L. **Deps:** email, jobs. **Tier:** Core.

### 7. Multiple pipelines & multiple page layouts [Table-stakes]
- **Who/how:** Zoho multiple pipelines (Pro) tied to page layouts; Freshsales multi-pipeline (Pro, 1/10/25); Salesforce record types (Pro).
- **Fit:** See Pipedrive brief #1 (Pipeline model). Layouts pair with custom fields.
- **Effort:** M. **Deps:** none. **Tier:** Core.

### 8. Web forms / lead capture [Table-stakes]
- **Who/how:** Zoho Web-to-Lead (Std, 10→100 forms/module); Freshsales web forms (Growth); Salesforce Web-to-Lead (Pro, 500 leads/day cap).
- **Fit:** See marketing `05-lead-capture`. Highest-ROI inbound feature.
- **Effort:** M. **Deps:** public API + lead object. **Tier:** Core.

### 9. Reports/dashboards + custom report builder [Table-stakes]
- **Who/how:** All three; custom report builder gates at Pro (Zoho Std reports, Freshsales custom builder Pro, Salesforce Starter has canned only).
- **Fit:** See product `04-reporting-dashboards` + backend `15-reporting-analytics-backend`.
- **Effort:** L. **Deps:** stage-event log. **Tier:** Core.

### 10. Process automation w/ SLAs — Zoho Blueprint [Differentiator — Zoho]
- **Who/how:** Zoho **Blueprint** (Pro) models a stage process as **States + Transitions** that enforce mandatory fields/checklists and **SLAs** with escalation — users can't skip steps.
- **Why it matters:** Enforces a repeatable sales process & data quality; distinctive vs. a plain Kanban.
- **Fit:** Layer on the pipeline: define allowed stage transitions + required fields per transition; enforce in `moveDealToStage`. Pairs with required-fields and automation.
- **Effort:** L. **Deps:** custom fields, automation. **Tier:** Strategic Bet.

### 11. No-code record/page designer — Zoho Canvas [Differentiator — Zoho]
- **Who/how:** Zoho **Canvas** (Enterprise) is a drag-and-drop studio to restyle record detail pages (branding, conditional formatting). Salesforce Lightning App Builder is the analog (Pro).
- **Why it matters:** Per-team tailored record views without code; premium/enterprise selling point.
- **Fit:** Long-term; needs a layout/config model + dynamic renderer. Defer.
- **Effort:** L. **Deps:** custom fields, layouts. **Tier:** Strategic Bet (later).

### 12. AI assistant (scoring, summaries, email writing, next-best-action) [Differentiator]
- **Who/how:** Zoho **Zia**, Freshsales **Freddy**, Salesforce **Einstein/Copilot** — predictive scoring, deal insights, email drafting, anomaly detection. Gated to top tiers / add-ons everywhere.
- **Why it matters:** Fast-moving differentiator; strong upsell. Smart-CRM can ship AI early (Claude) as a wedge.
- **Fit:** New AI service: email draft/summarize, deal-risk summary, lead scoring assist, NL search. Uses latest Claude models. Reads contact/deal/activity context.
- **Effort:** M (assistive) → L (predictive). **Deps:** data model, search. **Tier:** Strategic Bet (high-leverage).

### 13. Assignment / round-robin routing + duplicate detection [Table-stakes]
- **Who/how:** Zoho assignment rules (Std) + dedupe (Std); Freshsales auto-assignment/round-robin (Pro); Salesforce assignment rules.
- **Fit:** Assignment as an automation action; dedupe via match keys (see backend `18-import-export-migration` merge).
- **Effort:** M. **Deps:** automation, merge. **Tier:** Core.

### 14. App marketplace + open API ecosystem [Differentiator — scale]
- **Who/how:** Zoho Marketplace (2,000+), Freshworks Marketplace (1,200+), Salesforce AppExchange; all on open REST APIs. Marketplace access generally not tier-gated; API quota scales.
- **Fit:** See backend `04-public-api` + `06-integrations-framework`. Long-term ecosystem play.
- **Effort:** L. **Deps:** public API, OAuth apps. **Tier:** Strategic Bet.

---

## Cross-competitor takeaways
- **Table-stakes Smart-CRM must reach:** custom fields, multiple pipelines, workflow automation, web forms, built-in email, scoring, reports/dashboards, assignment rules, sequences. These appear in *all three* and their absence is disqualifying for buyers comparing CRMs.
- **Differentiators to pick selectively:** Zoho's **Blueprint** (process+SLA) and **Canvas** (no-code UI); Freshsales' **built-in telephony** and generous free tier; Salesforce's **Flows + AppExchange** ecosystem.
- **AI is the live battleground** — all three gate real AI behind top tiers/add-ons. Smart-CRM shipping capable Claude-powered assistance earlier and lower is a credible wedge.

## Top 3 picks
1. **Lead/contact scoring + assignment routing** — table-stakes across all three, cheap on top of an automation engine.
2. **Zoho Blueprint-style process + SLAs** — a high-value differentiator that builds directly on our pipeline/stages.
3. **AI assistant (Claude-powered)** — email drafting, deal-risk summaries, NL search; ship it earlier/lower than competitors as a differentiator.
