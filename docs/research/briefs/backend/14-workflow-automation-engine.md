# Smart-CRM — Workflow Automation Engine (Backend Design Brief)

**Author:** Backend/Platform Engineering
**Date:** 2026-06-20
**Scope:** Design the no-code automation engine (trigger → conditions → actions). Marketing owns use-cases; this brief designs the ENGINE.
**Status:** RESEARCH/DESIGN ONLY — no repo changes.

---

## Context: where this plugs into Smart-CRM today

Read of the current codebase (`src/server/actions/*`, `src/lib/*`, `prisma/schema.prisma`):

- **Stack:** Next.js 15 (App Router) + Prisma 5 + Postgres 16 + NextAuth v5, deployed on Vercel (serverless / Fluid compute — functions are short-lived, no long-running daemons).
- **Mutation surface = trigger sources.** All writes flow through server actions: `createDeal`, `updateDeal`, `moveDealToStage`, `setDealStatus`, `deleteDeal` (`deals.ts`); `createContact`/`updateContact` (`contacts.ts`); `createActivity`/`toggleActivityComplete` (`activities.ts`); `setContactTags`/`createTag` (`tags.ts`); company + org actions. Each calls `requireOrg()` → `{ userId, orgId, role }`, validates with Zod, writes via `db` (singleton `PrismaClient` in `src/lib/db.ts`), then `revalidatePath`. There is **no domain-event emission** today — that is an explicit dependency.
- **Tenancy:** every domain row carries `orgId`; `requireOrg()` resolves the active org from the NextAuth session. The engine MUST be org-scoped end-to-end (no cross-tenant trigger leakage).
- **IDs:** `cuid()` everywhere. **Result type:** `ActionResult<T>` (`src/lib/action-result.ts`). **RBAC:** `requireRole(role, "ADMIN")` (`src/lib/rbac.ts`) — ranked MEMBER<ADMIN<OWNER.
- **Segmentation primitive:** `Tag` + `ContactTag` already exist → "add tag" is a cheap, high-value action.
- **Known gaps:** no triggers, no conditions engine, no actions framework, no execution log. **Hard dependencies:** (a) the **eventing capability** (domain events) and (b) the **jobs/queue capability** (async/delayed work). This brief assumes those land first and designs against their seams.

**Serverless reality (the central constraint).** Vercel functions are short-lived and can be killed at any `await` boundary; there is no in-process scheduler that survives a deploy. Therefore the engine cannot "run a workflow" inside the request that triggered it. It must (1) **enqueue** a durable run, and (2) advance that run **step-by-step** via re-invocations, persisting state after every step. This is exactly the model used by Inngest and Trigger.dev (durable execution via checkpoint/replay) ([Inngest: how functions are executed](https://www.inngest.com/docs/learn/how-functions-are-executed); [Trigger.dev: how it works](https://trigger.dev/docs/how-it-works)).

---

## Capability 1 — Domain Event Bus + Trigger Sources

**(1) What it enables.** A single, uniform stream of typed domain events (`deal.created`, `deal.updated`, `deal.stage_changed`, `deal.status_changed`, `contact.created`, `activity.completed`, `tag.added`, plus `schedule.tick` and `webhook.received`) that workflows subscribe to. Decouples "something happened in the CRM" from "what automation runs." This is the model n8n (trigger nodes start a run and provide initial data) and Inngest (everything is an event; fan-out = many functions on one event) both use ([n8n execution engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine); [Inngest fan-out](https://www.inngest.com/docs/guides/fan-out-jobs)).

**(2) Design.**

*Emission point.* Add a thin `emitEvent()` helper called from server actions **after** the DB write, inside the same logical operation. To guarantee no lost events on serverless, use the **transactional outbox** pattern: the action writes the domain row AND an `OutboxEvent` row in one `db.$transaction`; a separate drainer (queue consumer / cron) publishes outbox rows to the queue and marks them sent. This survives crashes between "write" and "publish."

```prisma
model OutboxEvent {
  id          String   @id @default(cuid())
  orgId       String
  type        String   // "deal.stage_changed"
  // Snapshot the record + a computed diff so conditions can read before/after
  payload     Json     // { entity:"deal", id, data:{...}, previous:{...}, changed:["stageId","status"] }
  actorUserId String?
  createdAt   DateTime @default(now())
  publishedAt DateTime?
  @@index([orgId, publishedAt])
  @@index([type])
}
```

*Trigger types (engine-level):*
- **record.created / record.updated** — emitted by create/update actions. `updated` carries `changed[]` (field diff) so triggers can filter "stage changed."
- **record.stage_changed / record.status_changed** — specialized, emitted by `moveDealToStage`/`setDealStatus` (cheaper than diffing on every update; mirrors HubSpot's distinct enrollment triggers).
- **time-based / scheduled** — a single Vercel Cron (`schedule.tick`, e.g. every 5 min) that (a) fires runs for delayed steps whose `wakeAt` has passed and (b) evaluates time-relative workflows ("3 days before `closeDate`"). Pipedrive and HubSpot both expose date-relative triggers.
- **inbound webhook** — `POST /api/automations/hooks/[token]`; the token resolves to `{orgId, workflowId}`, the body becomes the event payload. HMAC-verify if a secret is configured.

*Diff capture.* `updateDeal` currently reads `existing` then writes — extend that read to snapshot `previous` and compute `changed[]` for the event payload. Trigger definition stores the matching predicate:

```jsonc
// Workflow.trigger
{ "type": "record.updated", "entity": "deal",
  "changedFields": ["stageId"],                 // optional: only when these change
  "filter": { ">": [ {"var":"value"}, 10000 ] } // optional pre-condition (JSON Logic, see Cap 3)
}
```

**(3) Reference evidence.** Inngest is event-driven; fan-out = "send a single event and trigger multiple functions in parallel," each running independently for reliability ([Inngest fan-out](https://www.inngest.com/docs/guides/fan-out-jobs)). n8n trigger nodes "start workflow execution and provide initial data and define when and how a workflow runs" ([n8n engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)). HubSpot uses distinct enrollment triggers and supports event-based enrollment ([HubSpot event enrollment](https://knowledge.hubspot.com/workflows/set-event-enrollment-triggers)). Transactional outbox is the standard fix for "atomic DB write + reliable publish" — relevant because Vercel has no in-request guaranteed delivery.

**(4) Effort: M.** Deps: eventing capability (outbox + publisher), queue capability (consumer). Touches every server action (additive `emitEvent` line + diff snapshot).

**(5) Tier: Foundation.** Nothing else works without it.

---

## Capability 2 — Workflow Data Model (definition)

**(1) What it enables.** Persisted, versioned, org-scoped automation definitions: one trigger, a condition tree, an ordered/branched action list, enabled flag, plan-aware limits.

**(2) Design.**

```prisma
enum WorkflowStatus { DRAFT ACTIVE PAUSED ARCHIVED }

model Workflow {
  id          String         @id @default(cuid())
  orgId       String
  name        String
  status      WorkflowStatus @default(DRAFT)
  trigger     Json           // { type, entity, changedFields?, filter? }  (Cap 1)
  conditions  Json?          // JSON Logic condition tree (Cap 3); null = always
  // Ordered list of steps; supports branch/wait as step types (Cap 4)
  definition  Json           // { steps: Step[] }  — versioned graph
  version     Int            @default(1)
  // Re-enrollment & loop control (Cap 6)
  reentry     String         @default("ONCE") // ONCE | ALWAYS | EVERY_N_HOURS:<n>
  maxStepsPerRun Int         @default(50)     // recursion/loop guard ceiling
  createdBy   String?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
  org         Organization   @relation(fields: [orgId], references: [id], onDelete: Cascade)
  runs        WorkflowRun[]
  @@index([orgId, status])
  @@index([orgId, status, version])
}
```

- **`definition` as JSON, not normalized tables.** Steps are a graph (branches, waits) edited as a unit and versioned atomically — the same choice n8n makes (workflow = JSON DAG of nodes/edges) ([n8n data flow](https://deepwiki.com/n8n-io/n8n-docs/2.1-workflows-and-data-flow)). Normalizing into `WorkflowStep` rows buys little and complicates branch ordering. Validate the JSON with a Zod schema on save.
- **Versioning.** Bump `version` on edit; pin each run to the version it started on (store `workflowVersion` on `WorkflowRun`) so editing a live workflow never corrupts in-flight runs — this is how Inngest/Temporal-style engines keep long-running executions deterministic across deploys.
- **Org scope + RBAC.** All reads/writes go through `requireOrg()`; creating/editing/activating requires `requireRole(role, "ADMIN")` (consistent with `org.ts`). Members can view run logs.

**(3) Reference evidence.** n8n models a workflow as "a directed acyclic graph (DAG) of nodes connected by edges" ([n8n engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)). Inngest functions are defined declaratively with steps; pinning version-per-run is core to deterministic durable execution ([Inngest functions](https://www.inngest.com/docs/learn/inngest-functions)). HubSpot if/then branches send records down different paths based on properties ([HubSpot workflows guide](https://www.hubspot.com/products/workflow-automation-guide)).

**(4) Effort: S.** Deps: none beyond Prisma migration. Pure schema + Zod validators.

**(5) Tier: Foundation.**

---

## Capability 3 — Safe Condition Evaluator (no `eval`)

**(1) What it enables.** Marketing-defined conditions ("deal.value > 10000 AND deal.stage = Won AND contact has tag VIP") evaluated safely against the event payload — no arbitrary code execution, serializable to the DB, shareable between the builder UI and the engine.

**(2) Design.** Adopt **JSON Logic** as the on-disk condition format and evaluate with **`json-logic-engine`** (the modern, ~5–20× faster, deterministic, async-capable successor to `json-logic-js`, with better safeguards for untrusted rules) ([json-logic-engine](https://www.npmjs.com/package/json-logic-engine)).

```jsonc
// Workflow.conditions — tree, ANDs/ORs nest naturally
{ "and": [
  { ">":  [ { "var": "deal.value" }, 10000 ] },
  { "==": [ { "var": "deal.status" }, "WON" ] },
  { "in": [ "VIP", { "var": "contact.tags" } ] }
]}
```

- **Typed field catalog (the real safety layer).** Don't let conditions reference arbitrary `var` paths. Maintain a server-side **field registry** per entity (`deal.value: number`, `deal.stageId: enum<StageId>`, `contact.tags: string[]`, …). On save: validate every `var`/operator/operand against the registry with Zod (reject unknown fields, type-mismatched comparisons, disallowed operators). This is what makes it a **typed AST in practice** while keeping JSON Logic's portability — addresses the brief's "JSON logic / typed AST — avoid eval."
- **Operator allow-list.** Permit only `==,!=,>,>=,<,<=,in,!in,and,or,not,var` plus a few helpers (`startsWith`, `isEmpty`, date `before/after`). No custom function injection.
- **Evaluation context.** Build a flat object from the event payload + cheap lookups (e.g., resolve `contact.tags` once). Evaluation is pure and synchronous for primitives; async only if a condition needs a DB lookup (keep these rare).
- **Determinism / cost.** Cap tree depth and node count (e.g., ≤50 nodes) at save time to bound evaluation cost — mirrors HubSpot's 250-filter ceiling ([HubSpot enrollment](https://knowledge.hubspot.com/workflows/set-your-workflow-enrollment-triggers)).

**(3) Reference evidence.** JSON Logic is "designed with a lisp-like syntax… easy to write safe instructions that can be persisted into a database, and shared between the front-end and back-end" ([json-logic-engine](https://www.npmjs.com/package/json-logic-engine)). `json-logic-engine` offers "an optimized interpreter… ~5x faster… logic compilation for 12.5–20x… deterministic evaluation… better safeguards when evaluating rules from untrusted sources" (ibid). Alternatives considered: `json-rules-engine` (heavier, fact-oriented) and `datalogic-rs` (Rust; wrong runtime) ([json-rules-engine](https://www.npmjs.com/package/json-rules-engine); [datalogic-rs](https://github.com/json-logic/datalogic-rs)). Pipedrive/HubSpot both model conditions as filters that gate execution ([Pipedrive conditions](https://support.pipedrive.com/en/article/workflow-automation-conditions)).

**(4) Effort: S.** Deps: Cap 2 (where conditions live). One small dependency + a field registry + Zod validators.

**(5) Tier: Foundation.**

---

## Capability 4 — Action Framework + Action Types

**(1) What it enables.** A pluggable registry of action handlers (update field, create task/activity, send email, add tag, webhook, wait/delay, branch) that the executor runs in order. New actions = register a handler; the data model doesn't change.

**(2) Design.** A discriminated-union step schema and a typed `ActionHandler` interface.

```ts
// Step types stored in Workflow.definition.steps[]
type Step =
  | { id: string; type: "update_field"; entity: "deal"|"contact"|"company"|"activity"; set: Record<string, unknown> }
  | { id: string; type: "create_activity"; activity: { type: "TASK"|"CALL"|"MEETING"|"NOTE"; title: string; dueInDays?: number; ownerFrom?: "deal.owner"|"actor" } }
  | { id: string; type: "send_email"; templateId: string; to: "contact"|"deal.owner"|string }
  | { id: string; type: "add_tag"; tagId: string }            // reuses ContactTag
  | { id: string; type: "webhook"; url: string; secretRef?: string; body?: Json }
  | { id: string; type: "wait"; durationSec?: number; until?: JsonLogic }  // delay or wait-for-condition
  | { id: string; type: "branch"; on: JsonLogic; then: string; else?: string } // goto stepId

interface ActionHandler<S extends Step = Step> {
  type: S["type"];
  // Pure-ish; receives resolved context, returns a serializable result or a control signal
  run(step: S, ctx: ExecCtx): Promise<
    | { status: "done"; output?: Json }
    | { status: "sleep"; wakeAt: Date }          // wait/delay → durable pause (Cap 5)
    | { status: "goto"; stepId: string }         // branch
    | { status: "failed"; error: string; retryable: boolean }
  >;
}
```

- **`ExecCtx`** carries `{ orgId, actorUserId, event, vars, idempotencyKey, stepRunId }` and a tenant-scoped `db`. Every action writes through the same `orgId` guard the server actions use — no action may touch another tenant's rows.
- **Reuse existing actions where possible.** `add_tag` writes `ContactTag`; `create_activity` mirrors `createActivity`'s shape; `update_field` is a guarded `db.<entity>.update` constrained to the field registry (Cap 3) so an automation can only set allowed, type-checked fields. **Loop-guard note:** `update_field`/`add_tag` themselves emit events (Cap 1) — the loop guard (Cap 6) is what prevents A-triggers-B-triggers-A storms.
- **`send_email`** depends on a transactional email capability; v1 can stub to a queued `email.send` job.
- **`webhook`** is the generic escape hatch (n8n's whole philosophy) — POST with retry + timeout, secret from a server-side ref (never inline).
- **Ordered execution with branch/wait.** Steps run top-to-bottom (like Pipedrive: "executed from the top… step 3 only after step 2") ([Pipedrive first steps](https://support.pipedrive.com/en/article/workflow-automation)); `branch` jumps to a `stepId`; `wait` suspends the run (Cap 5).

**(3) Reference evidence.** n8n categorizes nodes as trigger / action / core(flow-control); "action nodes connect to external services… core nodes provide data transformation, logic, and flow control" ([n8n engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)). Pipedrive: each automation ≤10 actions, executed strictly in order ([Pipedrive limits via search](https://support.pipedrive.com/en/article/how-many-workflows-can-i-have-in-pipedrive)). HubSpot supports if/then branches + delays ([HubSpot guide](https://www.hubspot.com/products/workflow-automation-guide)).

**(4) Effort: M.** Deps: Cap 2, Cap 3, Cap 5 (executor invokes handlers). Email/webhook handlers may stub initially.

**(5) Tier: Core.**

---

## Capability 5 — Durable Execution Model on Serverless (runs, step-runs, retries, idempotency)

**(1) What it enables.** Reliable, resumable execution on Vercel: a workflow run advances one durable step at a time, survives function timeouts/deploys, retries failed steps independently, never double-applies a step, and supports long waits (days) without holding a process open.

**(2) Design.**

```prisma
enum RunStatus  { QUEUED RUNNING WAITING SUCCEEDED FAILED CANCELLED }
enum StepStatus { PENDING RUNNING SUCCEEDED FAILED SKIPPED }

model WorkflowRun {
  id              String    @id @default(cuid())
  orgId           String
  workflowId      String
  workflowVersion Int                          // pinned at start (Cap 2)
  status          RunStatus @default(QUEUED)
  triggerEventId  String?                      // OutboxEvent.id that started it
  // Idempotency: one run per (workflow, trigger entity, dedupe window) — see below
  dedupeKey       String                       @unique
  context         Json                         // resolved vars snapshot at enroll time
  cursor          Int       @default(0)        // index of next step
  wakeAt          DateTime?                     // set when WAITING (delay / wait-for-condition)
  stepsExecuted   Int       @default(0)        // loop/recursion guard counter (Cap 6)
  error           String?
  startedAt       DateTime  @default(now())
  finishedAt      DateTime?
  workflow        Workflow  @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  steps           StepRun[]
  @@index([orgId, workflowId, status])
  @@index([status, wakeAt])                     // cron picks up due WAITING runs
}

model StepRun {
  id        String     @id @default(cuid())
  runId     String
  stepId    String                              // matches Step.id in definition
  stepIndex Int
  type      String
  status    StepStatus @default(PENDING)
  attempt   Int        @default(0)              // per-step retry counter
  output    Json?                               // memoized result for replay
  error     String?
  startedAt DateTime?
  finishedAt DateTime?
  run       WorkflowRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  @@unique([runId, stepId])                      // idempotent step write
  @@index([runId, stepIndex])
}
```

**Execution flow (durable, replay-based — the Inngest/Trigger.dev model):**
1. **Enqueue.** Outbox publisher (Cap 1) hands a `deal.stage_changed` event to the queue consumer. Consumer finds ACTIVE workflows whose trigger matches and whose `conditions` pass (Cap 3), then **creates a `WorkflowRun`** with a computed `dedupeKey` (e.g. `sha(workflowId + version + entityId + reentryBucket)`). The `@unique` on `dedupeKey` makes enrollment **idempotent** — a duplicate event can't start a second run.
2. **Advance one step.** A "run-tick" job loads the run, reads `cursor`, and for the current step: if a `StepRun` for that `stepId` already `SUCCEEDED`, **skip and reuse its `output`** (memoization/replay); else mark `RUNNING`, invoke the handler (Cap 4), persist `output` + `SUCCEEDED`, bump `cursor` and `stepsExecuted`. Then enqueue the next run-tick. **Each step is its own short serverless invocation** → never hits a function timeout, exactly as Inngest/Trigger.dev checkpoint at `await` and resume in a fresh execution ([Inngest execution](https://www.inngest.com/docs/learn/how-functions-are-executed); [Trigger.dev](https://trigger.dev/docs/how-it-works)).
3. **Waits/delays.** A `wait` handler returns `{status:"sleep", wakeAt}`; the run goes `WAITING` with `wakeAt` set and **stops consuming compute** (a sleeping run doesn't count against concurrency — Inngest's exact semantic). The Cron tick (Cap 1) scans `status=WAITING AND wakeAt<=now()` and re-enqueues a run-tick. Long delays (up to a plan cap) cost nothing while paused.
4. **Retries.** On `{status:"failed", retryable:true}`, increment `StepRun.attempt` and re-enqueue with **exponential backoff**; **per-step retry counter** (a failing email retries without re-running an earlier `add_tag`). Default 3–4 attempts, then the step → `FAILED` and the run → `FAILED` (dead-letter); a non-retryable error fails immediately. This mirrors Inngest: "each `step.run()` has its own independent retry counter," custom retry counts, and a final-failure handler ([Inngest retries](https://www.inngest.com/docs/features/inngest-functions/error-retries/retries); [Inngest error handling](https://www.inngest.com/docs/guides/error-handling)).
5. **Idempotency end-to-end.** (a) Enrollment dedupe via `dedupeKey`; (b) step dedupe via `@@unique([runId, stepId])` + memoized output; (c) external side-effects (webhook/email) pass an **idempotency key** = `stepRunId` so a retry of a partially-applied step is safe. "Re-running a step upon error requires its code to be idempotent" ([Inngest principles](https://www.inngest.com/blog/principles-of-durable-execution)).

**(3) Reference evidence.** Inngest durable execution = incremental execution + state persistence + fault tolerance; "Inngest records each step so failed work can retry from the last successful checkpoint instead of restarting from scratch"; sleeping/waiting runs don't count against concurrency ([Inngest execution](https://www.inngest.com/docs/learn/how-functions-are-executed); [Inngest concurrency](https://www.inngest.com/docs/guides/concurrency)). Trigger.dev checkpoints state at `await` and restores into a new execution environment to avoid timeouts ([Trigger.dev how-it-works](https://trigger.dev/docs/how-it-works)). n8n stores per-execution `runData` keyed by node, supporting nodes that run multiple times in loops ([n8n engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)).

**(4) Effort: L.** Deps: queue capability (run-tick jobs), Cron (waits), Caps 1–4. This is the heart of the engine.

**(5) Tier: Core.**

---

## Capability 6 — Loop / Recursion Guards + Re-enrollment Control

**(1) What it enables.** Prevents runaway automations: A updates a field → fires B → which updates a field → re-fires A → infinite storm. Also controls whether the same record can re-enter a workflow.

**(2) Design.**
- **Per-run step ceiling.** `WorkflowRun.stepsExecuted` capped by `Workflow.maxStepsPerRun` (default 50); exceeding it fails the run with `LOOP_GUARD`. Bounds any single run.
- **Cross-workflow cascade depth.** Propagate a `causationDepth` in the event payload (incremented each time an action emits a new event). Refuse to start runs past a depth ceiling (e.g. 5). Tag automation-originated events with `actorUserId=null, source:"automation"` so cascades are traceable and so a workflow can opt out of self-triggering events.
- **Re-enrollment.** `Workflow.reentry`: `ONCE` (default — a record enrolls once; the `dedupeKey` omits a time bucket), `ALWAYS`, or `EVERY_N_HOURS:<n>` (dedupeKey includes a floored time bucket). Matches HubSpot's explicit re-enrollment model ([HubSpot enrollment settings](https://knowledge.hubspot.com/workflows/manage-workflow-enrollment-settings)).
- **Frequency caps (flow control).** Per-org and per-workflow execution ceilings over a rolling window (see Cap 7), plus optional **debounce** (collapse a burst of `deal.updated` on the same record into one enrollment within N minutes) — Inngest exposes debounce/rate-limit/concurrency as first-class flow control ([Inngest rate limiting](https://www.inngest.com/docs/guides/rate-limiting); [Inngest flow control via search](https://www.inngest.com/docs/learn/glossary)).

**(3) Reference evidence.** Pipedrive enforces frequency limits "to protect system performance": 10,000 executions/10 min company-wide and 5,000/10 min per automation ([Pipedrive frequency limits via search](https://support.pipedrive.com/en/article/workflow-automation-frequency-limits)). HubSpot defaults records to enroll once and requires explicit re-enrollment config ([HubSpot enrollment](https://knowledge.hubspot.com/workflows/manage-workflow-enrollment-settings)). Inngest debounce "prevents duplicate events from triggering a function more than once" within a window ([Inngest flow control](https://www.inngest.com/docs/learn/glossary)).

**(4) Effort: S.** Deps: Caps 1, 5 (counters live on the run / event payload).

**(5) Tier: Core.** Ship with the executor — without guards, a single bad workflow can melt the DB.

---

## Capability 7 — Plan Limits, Quotas & Throttling

**(1) What it enables.** Enforce per-plan caps so automation cost/load is bounded and tiering is monetizable: number of active workflows, actions per workflow, max delay duration, condition complexity, and execution frequency.

**(2) Design.** A `PLAN_LIMITS` config (code constant keyed by plan; org carries a `plan`) checked at two points: **save/activate time** (static caps) and **enqueue time** (rate caps).

```ts
const PLAN_LIMITS = {
  FREE:       { activeWorkflows: 1,  actionsPerWorkflow: 3,  maxDelayDays: 1,  maxConditionNodes: 10, execPer10min: 100 },
  PRO:        { activeWorkflows: 30, actionsPerWorkflow: 10, maxDelayDays: 30, maxConditionNodes: 50, execPer10min: 5_000 },
  ENTERPRISE: { activeWorkflows: Infinity, actionsPerWorkflow: 25, maxDelayDays: 90, maxConditionNodes: 250, execPer10min: 10_000 },
} as const;
```

- **Static checks** (on `activate`): count ACTIVE workflows for the org; count actions in `definition` (use **longest branch path**, per Pipedrive, so branching isn't penalized); sum `wait` durations ≤ `maxDelayDays`; condition node count ≤ `maxConditionNodes`. Return `fail("Plan limit reached: …")` via `ActionResult`.
- **Rate checks** (at enqueue): a rolling counter (e.g., Postgres `WorkflowRunCounter` keyed by `orgId + windowStart`, or Redis if available) enforces `execPer10min` per-org and per-workflow; over-limit events are **dropped with an audit log entry** (Pipedrive skips; Inngest rate-limit skips excess events) rather than queued unbounded.
- **Observability.** Surface counts in settings ("23 / 30 active workflows", run success rate) — HubSpot exposes per-workflow throughput/goal stats ([HubSpot guide](https://www.hubspot.com/products/workflow-automation-guide)).

**(3) Reference evidence.** Pipedrive per-plan active-automation caps: Advanced 30, Professional 60, Power 90, Enterprise unlimited; ≤10 actions/automation; total delays ≤90 days; limits computed from the **longest branch path** ([Pipedrive limits](https://support.pipedrive.com/en/article/how-many-workflows-can-i-have-in-pipedrive); [Pipedrive delay](https://support.pipedrive.com/en/article/workflow-automations-delay-feature); [Pipedrive plans](https://support.pipedrive.com/en/article/new-pipedrive-plans)). Pipedrive frequency limits 10k/10min org + 5k/10min per automation ([Pipedrive frequency](https://support.pipedrive.com/en/article/workflow-automation-frequency-limits)). HubSpot gates advanced triggers behind higher tiers and caps enrollment filters at 250 ([HubSpot enrollment](https://knowledge.hubspot.com/workflows/set-your-workflow-enrollment-triggers)). Inngest publishes run/throughput usage limits and uses GCRA rate limiting ([Inngest usage limits](https://www.inngest.com/docs/usage-limits/inngest); [Inngest rate limit](https://www.inngest.com/docs/reference/typescript/functions/rate-limit)).

**(4) Effort: S.** Deps: Caps 2, 5; an org `plan` field (likely from a billing capability — stub to `PRO` initially).

**(5) Tier: Core.**

---

## Capability 8 — Execution Log, Observability & Manual Controls

**(1) What it enables.** Operators can see why an automation did/didn't run, inspect each step's input/output/error, retry or cancel a run, and test a workflow before activating. Critical for a no-code tool — most "automation isn't working" tickets are debuggability problems (n8n and Pipedrive both ship dedicated execution/troubleshooting views).

**(2) Design.**
- **The log already exists** as `WorkflowRun` + `StepRun` (Cap 5): status, per-step `output`/`error`, attempts, timestamps. Add a read API (org-scoped) + UI: timeline per run, filter by workflow/status/date.
- **Skip reasons.** When a workflow matches a trigger but conditions fail or limits block it, write a lightweight `WorkflowRun` with `status=SKIPPED`/`CANCELLED` and a reason (or a separate `SkipLog`) so "why didn't it fire?" is answerable.
- **Manual controls (server actions, ADMIN):** `retryRun(runId)` (re-enqueue from the failed step, reusing memoized successes), `cancelRun(runId)`, `activate/pause workflow`. All via `ActionResult` + `requireRole(role,"ADMIN")`.
- **Test/dry-run mode.** Run a workflow against a sample record with side-effecting handlers in "simulate" (log intended writes, don't persist) — mirrors n8n manual/partial executions ([n8n executions](https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/)).
- **Retention.** Prune `StepRun`/`WorkflowRun` past a window (e.g. 30–90 days by plan) via the Cron — Inngest documents run-retention by plan ([Inngest usage limits](https://www.inngest.com/docs/usage-limits/inngest)).

**(3) Reference evidence.** n8n stores `runData` per node and exposes manual/partial/production execution views for debugging ([n8n executions](https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/); [n8n engine](https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine)). Pipedrive ships an automation troubleshooting view ([Pipedrive troubleshooting](https://support.pipedrive.com/en/article/troubleshooting-automations?category=troubleshooting)). HubSpot surfaces per-workflow throughput + goal stats ([HubSpot guide](https://www.hubspot.com/products/workflow-automation-guide)). Inngest provides per-run observability and onFailure handlers ([Inngest error handling](https://www.inngest.com/docs/guides/error-handling)).

**(4) Effort: M.** Deps: Cap 5 (the log rows). Mostly read-API + UI + a few control actions + a prune job.

**(5) Tier: Strategic Bet.** Not required to *run* automations, but it's the difference between a toy and a trustworthy product — invest once Core works.

---

## Summary table

| # | Capability | Effort | Tier | Key deps |
|---|------------|--------|------|----------|
| 1 | Domain Event Bus + Trigger Sources | M | Foundation | eventing, queue |
| 2 | Workflow Data Model (definition) | S | Foundation | Prisma migration |
| 3 | Safe Condition Evaluator (JSON Logic + typed registry) | S | Foundation | Cap 2 |
| 4 | Action Framework + Action Types | M | Core | Caps 2,3,5 |
| 5 | Durable Execution Model (runs/steps/retries/idempotency) | L | Core | queue, cron, Caps 1–4 |
| 6 | Loop/Recursion Guards + Re-enrollment | S | Core | Caps 1,5 |
| 7 | Plan Limits, Quotas & Throttling | S | Core | Caps 2,5, billing |
| 8 | Execution Log, Observability & Manual Controls | M | Strategic Bet | Cap 5 |

---

## Top 3 picks

1. **Durable Execution Model (Cap 5)** — the irreducible core. On Vercel's short-lived functions, the only way to run multi-step, delayed, retryable workflows is durable step-by-step execution with `WorkflowRun`/`StepRun`, memoized replay, per-step retries, and idempotency keys (the proven Inngest/Trigger.dev pattern). Everything else is scaffolding around this.
2. **Domain Event Bus + Trigger Sources (Cap 1)** — the engine is inert without triggers. The transactional-outbox emission from existing server actions (with field diffs) is the safe, lossless way to turn CRM mutations into the typed event stream workflows subscribe to. Foundational and unblocks all others.
3. **Safe Condition Evaluator (Cap 3)** — JSON Logic (`json-logic-engine`) gated by a typed, per-entity field registry gives marketing expressive, portable conditions with zero `eval`/injection risk, at S effort. High leverage: it's what makes the no-code builder both powerful and safe.

---

### Sources
- Inngest — How functions are executed (durable execution): https://www.inngest.com/docs/learn/how-functions-are-executed
- Inngest — Principles of durable execution: https://www.inngest.com/blog/principles-of-durable-execution
- Inngest — Retries: https://www.inngest.com/docs/features/inngest-functions/error-retries/retries
- Inngest — Errors & Retries: https://www.inngest.com/docs/guides/error-handling
- Inngest — Fan-out: https://www.inngest.com/docs/guides/fan-out-jobs
- Inngest — Concurrency: https://www.inngest.com/docs/guides/concurrency
- Inngest — Rate limiting: https://www.inngest.com/docs/guides/rate-limiting
- Inngest — Rate limit reference (GCRA): https://www.inngest.com/docs/reference/typescript/functions/rate-limit
- Inngest — Glossary (flow control/debounce): https://www.inngest.com/docs/learn/glossary
- Inngest — Usage limits: https://www.inngest.com/docs/usage-limits/inngest
- Inngest — Functions: https://www.inngest.com/docs/learn/inngest-functions
- Trigger.dev — How it works (checkpoint/resume): https://trigger.dev/docs/how-it-works
- Trigger.dev — v3 announcement (durable serverless, no timeouts): https://trigger.dev/blog/v3-announcement
- n8n — Workflow execution engine (DeepWiki): https://deepwiki.com/n8n-io/n8n/2-workflow-execution-engine
- n8n — Workflows & data flow (DeepWiki): https://deepwiki.com/n8n-io/n8n-docs/2.1-workflows-and-data-flow
- n8n — Executions (manual/partial/production): https://docs.n8n.io/workflows/executions/manual-partial-and-production-executions/
- HubSpot — Workflow automation guide: https://www.hubspot.com/products/workflow-automation-guide
- HubSpot — Set event enrollment triggers: https://knowledge.hubspot.com/workflows/set-event-enrollment-triggers
- HubSpot — Manage enrollment settings (re-enrollment): https://knowledge.hubspot.com/workflows/manage-workflow-enrollment-settings
- HubSpot — Set enrollment triggers (250-filter cap): https://knowledge.hubspot.com/workflows/set-your-workflow-enrollment-triggers
- Pipedrive — Automation limits (active counts, longest branch): https://support.pipedrive.com/en/article/how-many-workflows-can-i-have-in-pipedrive
- Pipedrive — Delay feature (90-day cap): https://support.pipedrive.com/en/article/workflow-automations-delay-feature
- Pipedrive — Wait for condition: https://support.pipedrive.com/en/article/automation-wait-for-condition
- Pipedrive — Conditions: https://support.pipedrive.com/en/article/workflow-automation-conditions
- Pipedrive — First steps (ordered actions): https://support.pipedrive.com/en/article/workflow-automation
- Pipedrive — Frequency limits (10k/5k per 10min): https://support.pipedrive.com/en/article/workflow-automation-frequency-limits
- Pipedrive — New plans: https://support.pipedrive.com/en/article/new-pipedrive-plans
- json-logic-engine (modern, safe, faster successor to json-logic-js): https://www.npmjs.com/package/json-logic-engine
- json-rules-engine (alternative considered): https://www.npmjs.com/package/json-rules-engine
- datalogic-rs (Rust JSONLogic, alternative considered): https://github.com/json-logic/datalogic-rs
