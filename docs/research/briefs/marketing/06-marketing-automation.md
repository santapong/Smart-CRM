# Marketing Automation & Customer Journeys — Smart-CRM Research

**Author:** Marketing research (Marketing automation & customer journeys)
**Date:** 2026-06-20
**Scope:** Product/marketing view of automation — use-cases, recipes, segmentation, journey design, and no-code builder UX. The automation *engine* internals (queues, idempotency, schedulers) are owned by the backend team; this doc focuses on **what small teams want to automate** and **how it maps onto Smart-CRM's existing data model**.

---

## Why this matters for Smart-CRM

Smart-CRM today has Contacts (+Tags), Companies, Deals (stages/status), Activities, a Dashboard, and RBAC, but **no automations, segments, journeys, or triggers** (per repo `prisma/schema.prisma` and `src/server/actions/*`). Every competitor a small team evaluates — HubSpot, Pipedrive, ActiveCampaign, Customer.io — leads with a visual trigger→condition→action workflow builder. This is the single biggest "feels like a real CRM" gap.

The good news: the repo is **already shaped for this**. The server actions are the natural trigger emission points, and Tags are a ready-made segmentation primitive.

### Existing trigger surfaces (from `src/server/actions/`)

These are the exact mutation points that should emit domain events for automations. All are already org-scoped via `requireOrg()`:

| Server action (file) | Natural trigger event |
|---|---|
| `createContact` / `updateContact` (`contacts.ts`) | `contact.created`, `contact.updated`, `contact.field_changed` |
| `setContactTags` (`tags.ts`) | `contact.tag_added`, `contact.tag_removed` |
| `createDeal` / `updateDeal` (`deals.ts`) | `deal.created`, `deal.updated` |
| `moveDealToStage` (`deals.ts`) | `deal.stage_changed` (has both `id` and `stageId`) |
| `setDealStatus` (`deals.ts`) | `deal.won`, `deal.lost`, `deal.reopened` (status enum WON/LOST/OPEN) |
| `createActivity` / `toggleActivityComplete` (`activities.ts`) | `activity.created`, `activity.completed` |
| Companies (`companies.ts`) | `company.created`, `company.updated` |

> **Fit note for engine integration:** because actions already centralize writes and call `revalidatePath`, an automation dispatch hook can be added right after the successful DB write (e.g. `await emitEvent(orgId, "deal.won", {...})`) without scattering trigger logic across the UI. This mirrors Pipedrive's model: *"Triggers are events that start an automated workflow, such as creating a new deal, moving a deal to a different stage, or adding a new contact"* ([Zeeg / Pipedrive guide](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)).

### Tags as the segmentation seed
`Tag` + `ContactTag` (unique `[orgId, name]`) already give us a labeling primitive. Two segmentation models map onto it directly:
- **Static segment** = a Tag applied manually or by automation (cheap; ships today).
- **Smart segment / active list** = a saved filter that auto-recomputes membership, optionally syncing a Tag. This mirrors HubSpot's distinction: *"Active segments automatically update their members based on their criteria, with records joining the segment when they meet the criteria and leaving when they no longer meet the criteria"* ([HubSpot — Create segments](https://knowledge.hubspot.com/segments/create-active-or-static-lists)).

---

## Competitive landscape (anchors used throughout)

- **HubSpot Workflows** — enrollment triggers (event / filter / schedule), actions grouped as *delays, branches, communication, CRM actions, AI* including **Create task, Set property value, Send internal email, Rotate record to owner (round-robin), If/Then branches**. If/Then branching is gated to Professional+ ([HubSpot — Choose your workflow actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions); [INSIDEA — branching logic](https://insidea.com/blog/hubspot/kb/how-to-use-branching-logic-in-hubspot-workflows)).
- **Pipedrive Workflow Automation** — strict trigger→condition→action; triggers on deal/person/activity created/updated/deleted & stage change; actions Send email, Create activity, Update deal, Create note, Change deal owner; **delays with "skip weekends"**; **36 pre-made templates**; gated to Advanced+ ([Pipedrive — Workflow Automation](https://www.pipedrive.com/en/features/workflow-automation); [Zeeg guide](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)).
- **ActiveCampaign** — visual drag-and-drop builder; start triggers (tag added, field change, subscribes, date-based, score change, "enters a pipeline", "deal stage changes"); **wait (timed + conditional), conditional split, Goal (skip-ahead)**; CRM actions **Add deal, move deal stage, Add a deal task, adjust lead/deal score**; 900+ prebuilt recipes; from ~$19/mo ([ActiveCampaign — Triggers, Actions & Goals](https://www.activecampaign.com/platform/triggers-actions-goals); [AC — managing deals with automations](https://help.activecampaign.com/hc/en-us/articles/206821090-Using-automations-to-manage-your-deals); [AC — recipes](https://www.activecampaign.com/recipes)).
- **Customer.io Journeys** — campaigns triggered by **segment change, event, date, relationship, form, webhook**; data-driven segments auto-update; workflow steps delay/time-window/branch/attribute conditions; **conversion goals + exit conditions**; "Set journey attributes" action ([Customer.io — Journeys overview](https://docs.customer.io/journeys/journeys-overview/); [C.io — campaign triggers](https://docs.customer.io/journeys/campaign-triggers/)).

---

# Ideas

Each idea: (1) name + desc, (2) competitor evidence, (3) fit with Smart-CRM, (4) Effort + deps, (5) tier.

Tiers: **Foundation** (table stakes / unlocks everything else) · **Differentiator** (competitive parity that wins small-team deals) · **Premium** (advanced / paid-plan gating later).

---

## 1. No-code Workflow Builder (trigger → condition → action)
**Desc:** The core canvas. User picks a **trigger** (from the event list above), adds optional **conditions** (filters on the record), and an ordered list of **actions**. Start with a linear list-style builder (Pipedrive-style) rather than a free-form graph — far simpler to build and entirely adequate for small teams.

**Competitor evidence:** Pipedrive's model is exactly trigger→condition→action with "Add action" choosing Send email / Create activity / Update deal / Change deal owner ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)). HubSpot groups actions as delays/branches/communication/CRM ([HubSpot actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions)). ActiveCampaign and Customer.io use drag-and-drop canvases, but that's heavier UX ([C.io visual builder](https://customer.io/features/visual-workflow-builder)).

**Fit:** Triggers map 1:1 to server actions (table above). Conditions are Zod-validated JSON filter objects over Contact/Deal/Activity fields. Actions reuse existing server-action logic (create activity, set tags, set deal status/stage). New models needed: `Automation`, `AutomationStep`, `AutomationRun` (engine team owns runtime). UI: shadcn forms + a step list — no graph library required for v1.

**Effort:** **L** — deps: engine event bus + job runner (backend), new Prisma models, `automations` server actions, builder UI.
**Tier:** Foundation.

---

## 2. Smart Lists / Dynamic Segments (auto-updating, Tag-backed)
**Desc:** A saved set of filter rules over contacts (e.g. `title contains "VP" AND no activity in 30d AND tag = newsletter`) that **recomputes membership automatically**. Two flavors: **static** (snapshot) and **smart/active** (live). Optionally, a smart list can **sync to a Tag** so the rest of the app (and automations) can reference it cheaply.

**Competitor evidence:** HubSpot active vs static lists — active lists auto add/remove members as criteria change, and *"contacts that enter the list after the workflow is turned on will also enter the workflow"* ([HubSpot — segments](https://knowledge.hubspot.com/segments/create-active-or-static-lists); [HubSpot — enrollment](https://knowledge.hubspot.com/workflows/set-your-workflow-enrollment-triggers)). Customer.io: *"Data-driven segments automatically update when people start or stop matching criteria"* ([C.io overview](https://customer.io/docs/journeys/journeys-overview/)).

**Fit:** This is the marketing centerpiece and leans directly on Tags. Reuse the same filter-expression schema as workflow conditions (idea #1) — build once, use in both. New model `Segment { rules Json, syncTagId? }`. The existing `setContactTags` action becomes the membership-sync mechanism. The contacts list page already exists to host a "Save as segment" affordance.

**Effort:** **M** — deps: shared filter-expression engine, recompute job (on contact write + nightly), `segments` server actions, segment UI on `/contacts`.
**Tier:** Foundation (segmentation is the marketer's primary surface).

---

## 3. "Segment change" enrollment trigger (membership entered/left)
**Desc:** Let automations be triggered by **a contact entering or leaving a smart list** — not just by raw record events. This is what turns segments into journeys ("when a contact enters *Cold Leads*, start re-engagement").

**Competitor evidence:** Customer.io's headline trigger is **Segment change** — *"You can trigger campaigns by segments... choose a trigger by selecting 'Segment change'"* ([C.io — campaign triggers](https://docs.customer.io/journeys/campaign-triggers/)). HubSpot supports list-membership enrollment + re-enrollment when a contact leaves and re-enters ([HubSpot community — re-enrollment by list membership](https://community.hubspot.com/t5/HubSpot-Ideas/Allow-Re-enrollment-in-a-workflow-based-on-Company-List/idi-p/509879)).

**Fit:** Depends on #2 emitting `segment.entered` / `segment.left` events from the recompute job. Tight, high-value coupling of segmentation → automation. Marketing-defining feature.

**Effort:** **M** — deps: #1 + #2; segment recompute must diff membership and emit events.
**Tier:** Differentiator.

---

## 4. Nurture Journeys (multi-step sequences with delays)
**Desc:** Pre-built, editable multi-step **time-based sequences**: e.g. a 4-touch new-lead welcome, a 3-touch trial nurture, a stalled-deal re-engagement. Built on the workflow builder + a **Delay/Wait** action (timed and "wait until condition").

**Competitor evidence:** ActiveCampaign **wait** action has timed + conditional variants ([AC — actions explained](https://help.activecampaign.com/hc/en-us/articles/218251828)). Pipedrive delays support **"skip weekends"** ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)). Customer.io onboarding campaign is the canonical multi-step nurture ([C.io — onboarding campaign](https://customer.io/docs/journeys/onboarding-campaign/)).

**Fit:** Requires a **Delay/Wait** step type + scheduler (engine). The journey *content* is the marketing deliverable: ship 3–5 templates a small team can clone. Email send action depends on an email-sending capability (see #11). Until email exists, journeys can still create tasks/notes (internal nurture).

**Effort:** **M** (sequences on top of #1) / **L** if it includes email. Deps: scheduler, delay step, recipe templates.
**Tier:** Differentiator.

---

## 5. Lead Lifecycle Automation (lifecycle stage field + auto-transitions)
**Desc:** Add a **lifecycle stage** to Contact (Subscriber → Lead → MQL → SQL → Customer) and automate transitions: e.g. "tag added `requested-demo` → set stage = MQL → create task for owner"; "deal Won → set associated contact stage = Customer."

**Competitor evidence:** HubSpot's default lifecycle stages are exactly Subscriber/Lead/MQL/SQL/Opportunity/Customer/Evangelist, and lead scoring auto-promotes between them ([Flowbird — lifecycle stages](https://flowbird.co.uk/blog/definition-of-lifecycle-stages-and-mql/sql/opp); search synthesis on lifecycle automation).

**Fit:** Small schema add (`Contact.lifecycleStage` enum) + automations using existing triggers (`contact.tag_added`, `deal.won`). Gives marketing a clean funnel taxonomy and powers funnel dashboards. Natural recipe library anchor.

**Effort:** **S** (field + a few seeded recipes) once #1 exists. Deps: #1, one migration.
**Tier:** Differentiator.

---

## 6. Lead Scoring (behavioral + attribute points → threshold action)
**Desc:** Accumulate points per contact from attributes (title, company size) and behavior (activity completed, tag added), with rules that fire at thresholds ("score ≥ 50 → set MQL, notify owner, create deal").

**Competitor evidence:** ActiveCampaign — *"when a contact score reaches a threshold score, a deal record is automatically created and placed in your pipeline"*, with **Score changes** trigger and add/subtract points on deal-stage change ([AC — managing deals](https://help.activecampaign.com/hc/en-us/articles/206821090-Using-automations-to-manage-your-deals)). HubSpot lead scoring promotes Lead→MQL→SQL at thresholds (lifecycle search synthesis).

**Fit:** New `Contact.score Int` + `ScoringRule` model; a `contact.score_changed` event feeds back into the trigger system. Pairs with #5 (score → lifecycle stage). More moving parts, good as a fast-follow.

**Effort:** **M** — deps: #1, scoring model, score-change event.
**Tier:** Premium.

---

## 7. Conditional Branching (If/Then) & Goals
**Desc:** Let a workflow **split** based on a condition ("if deal value > $10k → notify manager; else → standard task") and define a **Goal** that lets a record skip ahead when it satisfies a condition.

**Competitor evidence:** HubSpot If/Then branches across all objects, gated to Professional+ ([INSIDEA](https://insidea.com/blog/hubspot/kb/how-to-use-branching-logic-in-hubspot-workflows)). ActiveCampaign **conditional split** + **Goal** (skip-ahead): *"if someone purchases before reaching your sales email, the goal step pulls them out of the sales sequence"* ([AC — triggers/actions/goals](https://www.activecampaign.com/platform/triggers-actions-goals)).

**Fit:** Extends the step model with branch/goal node types and reuses the filter-expression schema (#2). A clean later candidate for **paid-plan gating** (matches HubSpot's Pro+ gate). Linear builder (#1) should ship first.

**Effort:** **L** — deps: #1, branch/goal runtime, builder UI for branches.
**Tier:** Premium.

---

## 8. Owner Rotation / Round-Robin Lead Assignment
**Desc:** Auto-assign new contacts/deals to team members in rotation (or by rule), so inbound leads don't pile on one rep.

**Competitor evidence:** HubSpot **"Rotate record to owner"** for round-robin assignment among a list of qualifying users ([HubSpot actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions)). Pipedrive **Change deal owner** action ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)). ActiveCampaign assigns the lead to a salesperson on score threshold ([AC — managing deals](https://help.activecampaign.com/hc/en-us/articles/206821090-Using-automations-to-manage-your-deals)).

**Fit:** Action sets `Deal.ownerId` / introduces a `Contact.ownerId` (small add). Uses `Membership` (org users) as the rotation pool, respecting RBAC. High-value, low-complexity action for the action library.

**Effort:** **S** (as an action) once #1 exists. Deps: #1; optional `Contact.ownerId` migration.
**Tier:** Differentiator.

---

## 9. Internal Notifications & Task Auto-Creation
**Desc:** Action types that **create an Activity (task)** and **notify a teammate** (in-app + email-to-user) on triggers — the workhorses of every small-team automation.

**Competitor evidence:** HubSpot **Create task** + **Send internal email** *"to a specific user, team, or owner"* ([HubSpot actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions)). Pipedrive **Create activity / Create note** ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)). ActiveCampaign **Add a deal task** ([AC — managing deals](https://help.activecampaign.com/hc/en-us/articles/206821090-Using-automations-to-manage-your-deals)).

**Fit:** The "create task" action is *literally* `createActivity` (`activities.ts`) called by the engine — minimal new code, maximum value. Internal notification needs a lightweight notify mechanism (in-app first; email is a thin add). These two actions make the builder useful on day one even with no email.

**Effort:** **S** — deps: #1; reuse `createActivity`; in-app notification surface.
**Tier:** Foundation (ships inside #1's action set).

---

## 10. Automation Recipe Library / Templates Gallery
**Desc:** A one-click gallery of **pre-built, editable automations** so a small team gets value in minutes instead of building from a blank canvas. Categorized (Sales handoff, Onboarding, Nurture, Data hygiene, Re-engagement). See the ready-made recipe list below.

**Competitor evidence:** Pipedrive ships **36 pre-made templates** by collection ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)). ActiveCampaign has **900+ prebuilt recipes** ([AC recipes](https://www.activecampaign.com/recipes)). Templates are the #1 adoption lever for non-technical users.

**Fit:** Pure config on top of #1 — each template is a seeded `Automation` JSON the user clones into their org. Highest ROI-per-effort once the builder exists; this is where marketing directly drives the product.

**Effort:** **S–M** — deps: #1 (+ #2/#4 for segment/nurture recipes); content authoring.
**Tier:** Differentiator.

---

## 11. Email Send action + simple templates (marketing email)
**Desc:** An **Send email** action with a basic template + merge fields (`{{firstName}}`, `{{company}}`), enabling true marketing journeys (welcome, nurture, re-engagement) rather than internal-only automations.

**Competitor evidence:** Every competitor's primary action is sending email; ActiveCampaign/Customer.io are fundamentally email/messaging journey tools ([AC — triggers/actions/goals](https://www.activecampaign.com/platform/triggers-actions-goals); [C.io platform](https://customer.io/platform/journeys)).

**Fit:** Biggest external dependency (sending provider, deliverability, unsubscribe/consent, suppression). Worth flagging as the **gateway to "real" marketing automation**, but sequence it after the internal-action builder proves out. Consent/unsubscribe handling is mandatory and non-trivial.

**Effort:** **L** — deps: email provider integration, template editor, unsubscribe + suppression list, `EmailLog`.
**Tier:** Premium.

---

## 12. Automation Run History & Activity Log (transparency)
**Desc:** A per-automation **run log** ("enrolled 12 contacts today, 11 succeeded, 1 skipped: no email") and a per-record timeline entry when an automation acts on it. Builds trust that automations are doing the right thing.

**Competitor evidence:** Customer.io exposes journey/conversion tracking and exit conditions ([C.io — campaign triggers](https://docs.customer.io/journeys/campaign-triggers/)); HubSpot shows enrollment history per workflow. Visibility is a top reason teams trust (and keep paying for) automation.

**Fit:** `AutomationRun` rows (engine writes them) surfaced in a simple table UI + a line on the Contact/Deal detail timeline. Low marketing-side complexity; high confidence/retention payoff. Also the natural home for a kill-switch/pause.

**Effort:** **S–M** — deps: engine emits run records; read-only UI.
**Tier:** Differentiator.

---

# Ready-made automation recipes (clone-and-go)

Concrete recipes a small team wants on day one. Each is expressible with Smart-CRM's existing trigger surfaces + the action set above. (Format: **Trigger → Condition → Action(s)**.)

1. **Deal Won → Onboarding kickoff.** `deal.won` → (none) → create Activity "Onboarding call" assigned to deal owner + set contact lifecycle = Customer + apply Tag `customer`. *Mirrors Pipedrive's deal-Won → onboarding-activity + label-to-Customer handoff ([Pipedrive guide / Process Culture](https://www.processculture.com.au/articles/pipedrive-automation-5-workflows)).*
2. **New deal → First-touch task.** `deal.created` → value > 0 → create Activity "First call" due in 1 day to owner. *Pipedrive: "when a deal is created, automatically create an activity 'First call' in 1 hour" ([search synthesis](https://www.processculture.com.au/articles/pipedrive-automation-5-workflows)).*
3. **Tag added → Segment + nurture.** `contact.tag_added = requested-demo` → set lifecycle = MQL → notify sales owner + enroll in demo-nurture sequence. *ActiveCampaign tag-added start trigger ([AC triggers](https://www.activecampaign.com/platform/triggers-actions-goals)).*
4. **Stale deal → Re-engage owner.** schedule/daily → `deal.status = OPEN AND no activity in 7 days` → create task "Re-engage" + internal notification to owner. *Pipedrive "no activity for 7 days → notify owner" ([Process Culture](https://www.processculture.com.au/articles/pipedrive-automation-5-workflows)).*
5. **Deal moved to "Proposal Sent" → follow-up.** `deal.stage_changed → Proposal Sent` → wait 2 business days → create task "Check in on proposal." *Pipedrive stage-change + delay (skip weekends) recipe ([Zeeg](https://zeeg.me/en/blog/post/pipedrive-workflow-automation)).*
6. **New contact → Round-robin assign + welcome.** `contact.created` → assign owner via rotation (idea #8) + create "Intro call" task + (later) send welcome email. *HubSpot "Rotate record to owner" round-robin ([HubSpot actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions)).*
7. **Enters "Cold Leads" segment → re-engagement journey.** `segment.entered = Cold Leads` (no activity 30d) → 3-step re-engagement sequence; **Goal:** any new activity exits the journey. *Customer.io segment-trigger + goal/exit ([C.io triggers](https://docs.customer.io/journeys/campaign-triggers/)).*
8. **Data hygiene: missing email → flag.** `contact.created OR contact.updated` → email is empty → apply Tag `needs-email` + notify owner. *HubSpot data-hygiene workflows ([HubSpot actions](https://knowledge.hubspot.com/workflows/choose-your-workflow-actions)).*

---

## Sequencing summary

| Phase | Ideas | Why |
|---|---|---|
| **1 — Make it real** | #1 Builder, #2 Smart Lists, #9 Task/Notify actions, recipes 1–5 & 8 | Internal-only automations + segmentation; no external deps; proves the model |
| **2 — Make it marketing** | #3 Segment-change trigger, #4 Nurture journeys, #5 Lifecycle, #8 Owner rotation, #10 Templates, #12 Run history | Turns segments into journeys; lifecycle funnel; adoption levers |
| **3 — Make it premium** | #6 Lead scoring, #7 Branching/Goals, #11 Email send | Paid-plan gating candidates; bigger deps (email provider, deliverability) |

---

## Top 3 picks

1. **No-code Workflow Builder (trigger → condition → action)** — the foundation everything else plugs into; maps cleanly onto existing server actions; ship a linear (Pipedrive-style) builder first. *(Idea #1)*
2. **Smart Lists / Dynamic Segments (Tag-backed)** — the marketer's primary surface; builds on existing Tags, and its filter-expression engine is reused by workflow conditions and the segment-change trigger. *(Idea #2)*
3. **Automation Recipe Library + Task/Notify actions** — the adoption lever: a small team gets value in minutes via clone-and-go recipes (e.g. "Deal Won → onboarding task"), powered by `createActivity` with near-zero new runtime. *(Ideas #10 + #9)*
