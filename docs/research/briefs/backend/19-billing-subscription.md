# Billing & Subscription Backend — Design Brief

**Scope:** The Stripe-based billing engine for Smart-CRM — plans, seats, metering, invoices, entitlement enforcement. Marketing owns pricing/packaging; this brief owns the *engine* and the *gate*.

**Stack context (read from repo):**
- Next.js 15 + Prisma 5 + Postgres 16 + NextAuth v5 on Vercel. `pnpm`.
- Multi-tenant: `Organization` (the billable entity) + `Membership` (= seats; `@@unique([userId, orgId])`, roles `OWNER/ADMIN/MEMBER`). See `prisma/schema.prisma:70-98`.
- Entry point for all server actions is `requireOrg()` → `{ userId, orgId, role }` (`src/lib/tenant.ts:16-23`). **This is where entitlement checks hook in.**
- RBAC is rank-based: `requireRole(actual, required)` throwing `ForbiddenError` (`src/lib/rbac.ts`). The entitlement helper should mirror this shape.
- Server actions return an `ActionResult<T>` discriminated union via `ok()` / `fail()` (`src/lib/action-result.ts`). Gate failures should map to `fail("upgrade_required", ...)`.
- Env validated through `@t3-oss/env-nextjs` in `src/env.ts` — add Stripe vars there.
- **No jobs/webhooks/Stripe infra exists today** (`grep` for stripe/webhook/queue/cron = empty; only API route is NextAuth). Webhook capability below therefore *depends on* the jobs/webhooks design brief.

**Billing is keyed to `Organization`, not `User`.** The canonical T3/Taxonomy starter puts Stripe fields on `User` because it is single-tenant-per-user; Smart-CRM is multi-tenant, so the customer = org. We adapt the pattern, not copy it.

---

## 1. Stripe integration foundation (Checkout + Billing Portal, hosted-first)

**What it enables:** Org admins can subscribe, enter payment, and self-manage (upgrade/downgrade, update card, cancel, download invoices) without us building any payment UI, card vault, SCA/3DS, or invoice screens.

**Design:**
- **Checkout (hosted) for *acquisition*, Billing Portal (hosted) for *management*.** Both are Stripe-hosted redirect flows — minimal code, PCI/SCA/localization/tax handled by Stripe. Reserve the raw Subscriptions API only for programmatic changes we must drive ourselves (seat-quantity sync, plan swaps triggered by app events). Hosted-first is the explicit Stripe recommendation: "Use Stripe Checkout over custom payment forms, as it handles PCI, mobile, localization, and tax automatically."
- **One Stripe Customer per Organization.** Create lazily on first checkout; store `stripeCustomerId` on `Organization`. Pass `client_reference_id = orgId` and `metadata.orgId` on the Checkout Session so the webhook can resolve the org without a prior round-trip.
- Two server actions (admin-gated via `requireRole(role, "ADMIN")`):
  - `createCheckoutSession({ priceId })` → `stripe.checkout.sessions.create({ mode: "subscription", customer, line_items, client_reference_id: orgId, success_url, cancel_url, subscription_data: { metadata: { orgId } }, automatic_tax: { enabled: true } })`.
  - `createBillingPortalSession()` → `stripe.billingPortal.sessions.create({ customer, return_url })`. Portal lets customers "update payment methods, update subscriptions, cancel … pay, download, and view … invoices." Supports deep links (`flow_data`) for "go straight to cancel/update-plan".
- Stripe SDK singleton in `src/lib/stripe.ts` (mirror `src/lib/db.ts` global pattern), pinned `apiVersion`.
- Env additions to `src/env.ts`: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (publishable only if a client redirect helper is used; with hosted redirect URLs it may not be needed).

**Prisma sketch (org-level Stripe link):**
```prisma
model Organization {
  // ...existing...
  stripeCustomerId   String?  @unique
  subscription       Subscription?
}
```

**Reference:** Stripe "Build a subscriptions integration" (Customer + Checkout + Price + webhook flow); SaaS best-practice guidance to prefer Checkout for PCI/tax/localization; Billing Portal capability + deep links docs.

**Effort:** **M** — SDK wiring, two actions, env, one Customer-creation path. Deps: none (standalone; webhooks make it *correct* but checkout works without).

**Tier:** **Foundation**

---

## 2. Plan / Subscription / Entitlement data model

**What it enables:** A typed, queryable source of truth for "what is this org allowed to do," decoupled from Stripe so gates don't make a Stripe API call on every request.

**Design:**
- **`Plan` is config-as-code, not a heavy DB table.** Define plans (Free/Pro/Scale or whatever Marketing lands on) in a TS module (`src/lib/plans.ts`) mapping a plan key → `{ stripePriceId (seat), meteredPriceIds, limits, features }`. This is the Taxonomy approach (`freePlan`/`proPlan` constants) and keeps packaging changes in code review. A thin `Plan` DB row is optional and only needed if non-engineers must edit packaging at runtime.
- **`Subscription` is the local mirror of Stripe state**, keyed 1:1 to `Organization`. We persist exactly the fields needed to gate *without* calling Stripe, following the canonical Taxonomy/next-saas-stripe-starter field set — but on the org. Taxonomy stores `stripeCustomerId`, `stripeSubscriptionId`, `stripePriceId`, `stripeCurrentPeriodEnd` and treats a sub as active when `stripePriceId && stripeCurrentPeriodEnd + 86_400_000 > now` (a 1-day grace window so a slightly-late renewal webhook doesn't lock users out).
- **`Entitlement` = derived, not stored** for the common case. Resolve at call time: `subscription → planKey → limits/features`. Persist an `Entitlement`/overrides row only for per-org exceptions (sales-negotiated higher limits, comped features) — an escape hatch the gate consults before falling back to the plan default.

**Prisma sketch:**
```prisma
enum SubStatus { TRIALING ACTIVE PAST_DUE CANCELED UNPAID INCOMPLETE INCOMPLETE_EXPIRED PAUSED }

model Subscription {
  id                   String    @id @default(cuid())
  orgId                String    @unique
  org                  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  stripeSubscriptionId String?   @unique
  stripePriceId        String?              // seat price → maps to a plan key
  planKey              String    @default("free")
  status               SubStatus @default(TRIALING)

  seats                Int       @default(1) // last-synced quantity (see #3)
  currentPeriodEnd     DateTime?            // Taxonomy: + grace window for isActive
  cancelAtPeriodEnd    Boolean   @default(false)
  trialEndsAt          DateTime?

  updatedAt            DateTime  @updatedAt
}

// Optional per-org override (sales/comps). Absent rows → plan defaults.
model Entitlement {
  id        String  @id @default(cuid())
  orgId     String
  key       String              // feature flag or limit name, e.g. "limit.contacts"
  intValue  Int?
  boolValue Boolean?
  org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, key])
}
```

**Reference:** Taxonomy `prisma/schema.prisma` (`stripeCustomerId/stripeSubscriptionId/stripePriceId/stripeCurrentPeriodEnd`, all `@unique` where appropriate) and `lib/subscription.ts` `isPro = stripePriceId && stripeCurrentPeriodEnd.getTime() + 86_400_000 > Date.now()`; next-saas-stripe-starter uses the identical four-field model. Both verified verbatim from source.

**Effort:** **S** — schema + `plans.ts` config + one migration. Deps: #1 (for `stripeCustomerId` placement).

**Tier:** **Foundation**

---

## 3. Per-seat billing synced to Membership count

**What it enables:** Org pays for exactly the number of active members; adding/removing a member adjusts the bill with correct proration — no manual seat management.

**Design:**
- Seat price is a **recurring `Price` billed by `quantity`**; the subscription item's `quantity` = active `Membership` count for the org. Stripe per-seat works by "updating the subscription quantity when seats change."
- **Sync on membership mutation.** `inviteMember` / `removeMember` / accepted-invite already live in `src/server/actions/org.ts`. After the membership transaction commits, recompute `count = db.membership.count({ where: { orgId } })` and call `stripe.subscriptions.update(subId, { items: [{ id: itemId, quantity: count }], proration_behavior: "create_prorations" })`. `create_prorations` is Stripe's default and credits/charges the difference mid-cycle; use `always_invoice` if you want to bill the delta immediately rather than rolling it into the next invoice, or `none` to suppress.
- **Two important guardrails from Stripe:**
  1. *Rate limiting:* "Updating the quantity on a subscription many times in an hour may result in rate limiting." Mitigation: don't call Stripe inline on every membership write. Enqueue a **debounced seat-sync job** (depends on jobs capability) keyed by `orgId`; coalesce bursts (e.g. bulk invites) into one update. The DB `Subscription.seats` is the optimistic local value; the job reconciles to Stripe.
  2. *Pre-checkout writes:* if the org has no active subscription yet (Free plan), skip the Stripe call and just enforce the seat limit locally (#4).
- **Quantity is authoritative from `customer.subscription.updated` webhook**, not from our optimistic write — the webhook writes back the confirmed `quantity` to `Subscription.seats`, closing the loop.

**Effort:** **M** — hook into existing org actions + a debounced sync job. Deps: #1, #2, and the **jobs/queue** capability (for debounce + retry).

**Tier:** **Core**

---

## 4. Plan limits + entitlement check helper (`requireFeature` / `withinLimit`)

**What it enables:** A one-liner gate any server action can call to enforce feature access and resource caps — the actual *paywall enforcement*, server-side and tamper-proof.

**Design:** A small helper module `src/lib/entitlements.ts` mirroring the `rbac.ts` shape (throw-based + boolean variants), composed *after* `requireOrg()`:
```ts
// resolve once per request; cheap (one indexed read, no Stripe call)
export async function getEntitlements(orgId: string): Promise<Entitlements> {
  const sub = await db.subscription.findUnique({ where: { orgId } });
  const planKey = isActive(sub) ? sub.planKey : "free"; // isActive uses the +grace check
  const base = PLANS[planKey];
  const overrides = await db.entitlement.findMany({ where: { orgId } });
  return mergeOverrides(base, overrides);
}

export class UpgradeRequiredError extends Error { constructor(public feature: string) { super(`Requires plan with ${feature}`); } }

// feature gate (boolean flags: api_access, custom_fields, sso, ...)
export async function requireFeature(orgId: string, feature: FeatureKey) {
  const ent = await getEntitlements(orgId);
  if (!ent.features[feature]) throw new UpgradeRequiredError(feature);
}

// quota gate (countable limits: contacts, emails/mo, automation runs/mo, seats)
export async function withinLimit(orgId: string, limit: LimitKey, wouldAdd = 1): Promise<boolean> {
  const ent = await getEntitlements(orgId);
  const max = ent.limits[limit];           // null/Infinity = unlimited
  if (max == null) return true;
  const used = await currentUsage(orgId, limit); // counter read (see #5), not a live Stripe call
  return used + wouldAdd <= max;
}
```
- **Usage in actions:** in `createContact` (`src/server/actions/contacts.ts:22`), after `requireOrg()`:
  ```ts
  if (!(await withinLimit(orgId, "contacts"))) return fail("upgrade_required");
  ```
  Feature-gated actions (e.g. CSV export at `src/app/(app)/contacts/export/route.ts`, automation) call `requireFeature` and catch `UpgradeRequiredError` → `fail("upgrade_required")`. The `ActionResult` `error: "upgrade_required"` string lets the frontend render a paywall/upgrade CTA generically.
- **Fail-open vs fail-closed:** features fail *closed* (deny if unknown). Limits should fail *open on infra error* (don't block legitimate writes because a counter read errored) but *closed on a confirmed over-limit* — log either way.
- Limits live in `plans.ts` (`{ contacts: 1000, emailsPerMonth: 5000, automationRunsPerMonth: 1000, seats: 3 }`); `null` = unlimited.

**Reference:** Taxonomy `getUserSubscriptionPlan` + `isPro` as the canonical "resolve plan from stored Stripe state" pattern (adapted to org + extended from a single boolean to feature/limit maps); existing `requireRole` throw-based pattern in `src/lib/rbac.ts` as the in-repo convention to match.

**Effort:** **M** — helper + plan config + threading calls into ~6 action files. Deps: #2 (data model), #5 (for `currentUsage` on metered limits).

**Tier:** **Core**

---

## 5. Usage-based metering (contacts / emails / automation runs) with Stripe meters

**What it enables:** Bill overage or pure usage on consumption (emails sent, automation runs, contacts beyond plan), and feed the same counters into `withinLimit` for hard caps.

**Design:**
- **Two distinct counters per metric — keep them separate:**
  1. **Local fast counter** (Postgres) for `withinLimit` enforcement — must be synchronous and authoritative for *gating*. Stripe meter data "might have a slight delay," so it cannot back a hard cap.
  2. **Stripe Meter Events** for *billing* — fire-and-forget, eventually-consistent.
- **Stripe side:** create a `Meter` per billable metric (`event_name`, aggregation = `sum` or `count`), attach to a **metered `Price`**, add that price as a second subscription item alongside the seat price (hybrid: fixed seat + metered overage — "combines revenue predictability with fair value alignment"). Report via the **Meter Events API v2** — the legacy usage-records API was removed in API version `2025-03-31.basil`; every metered price now requires a backing Meter.
- **Emit a meter event** at each billable action: `stripe.v2.billing.meterEvents.create({ event_name, payload: { value: "1", stripe_customer_id }, identifier })`. Set `identifier` to a stable key (e.g. the domain row id or a ULID) for **idempotency** — Stripe "enforces uniqueness within a rolling period of at least 24 hours," so duplicate retries don't double-bill.
- **Local counter model** (also powers `currentUsage` in #4):
  ```prisma
  model UsageCounter {
    id        String   @id @default(cuid())
    orgId     String
    metric    String              // "contacts" | "emails" | "automationRuns"
    period    String              // "2026-06" billing-month bucket; or "current" for live totals
    count     Int      @default(0)
    org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
    @@unique([orgId, metric, period])
  }
  ```
  Increment with an atomic upsert in the same transaction as the domain write where correctness matters (`emails`, `automationRuns`); for `contacts` a periodic `count()` reconcile is fine since it's a live total.
- **Reliability:** meter-event emission should go through the **jobs/queue** (depends on that capability) so a Stripe outage doesn't fail user actions and events are retried. The v2 stream scales to ~100k events/sec, so volume is not the constraint — delivery reliability is.

**Reference:** Stripe Meters + Meter Events API v2 (event_name/payload/aggregation, idempotency `identifier` 24h uniqueness, data-freshness `data_at`); legacy usage-records removal in `2025-03-31.basil`; hybrid fixed+metered pricing guidance; Edgee scale write-up.

**Effort:** **L** — meters config, dual-counter logic, atomic increments across several actions, queued emission. Deps: #2, #3, jobs/queue.

**Tier:** **Strategic Bet**

---

## 6. Webhook handling for subscription lifecycle (idempotent, signature-verified)

**What it enables:** Stripe → local DB sync. Every subscription state change (paid, failed, trial ended, canceled, plan changed) updates `Subscription.status/planKey/currentPeriodEnd/seats` so entitlements are always current. **This is what makes #2–#5 correct.**

**Design:**
- Route: `src/app/api/stripe/webhook/route.ts`. Must read the **raw body** (`await req.text()`) — Next.js App Router route handlers don't pre-parse, so no body-parser config needed, but pass the raw string to verification.
- **Signature verification (mandatory):** `stripe.webhooks.constructEvent(rawBody, req.headers.get("stripe-signature"), STRIPE_WEBHOOK_SECRET)`. Reject (400) on failure — "always verify that webhook events originate from Stripe before acting." Unverified endpoints let an attacker forge subscription state.
- **Idempotency (mandatory):** delivery is at-least-once. Persist processed `event.id` and short-circuit duplicates:
  ```prisma
  model ProcessedWebhookEvent { id String @id /* = Stripe event.id */  type String  receivedAt DateTime @default(now()) }
  ```
  Insert-if-absent inside the handler's transaction; on unique-violation, treat as already processed and 200.
- **Ack fast, process reliably.** Best practice: "respond 200 immediately then hand work to a background queue." Two acceptable shapes:
  - *Inline-light:* verify → record event id → apply a small, fast DB update → 200. Acceptable because our handlers are single-row upserts.
  - *Queued:* verify → enqueue → 200, worker applies. Preferred once the **jobs/queue** capability exists, especially because seat-sync (#3) and meter retries (#5) already live there. **This capability depends on jobs/webhooks.**
- **Events handled → effect on `Subscription`:**
  | Event | Effect |
  |---|---|
  | `checkout.session.completed` | resolve org via `client_reference_id`; attach `stripeCustomerId`/`stripeSubscriptionId`; set `planKey` from price; status from sub |
  | `customer.subscription.created` / `.updated` | upsert `status`, `stripePriceId`→`planKey`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `seats` (confirmed `quantity`), `trialEndsAt` |
  | `customer.subscription.deleted` | `status = CANCELED`; downgrade entitlements to Free at period end |
  | `invoice.paid` | confirm `status = ACTIVE`, advance `currentPeriodEnd` |
  | `invoice.payment_failed` | `status = PAST_DUE`; trigger in-app dunning banner (#7) |
  | `customer.subscription.trial_will_end` | (3 days out) notify org admins to add a card (#7) |
- **Provisioning rule:** entitlements active when `status ∈ {TRIALING, ACTIVE}` **or** `PAST_DUE` within the grace window (`currentPeriodEnd + ~1 day`, per Taxonomy); `CANCELED/UNPAID/INCOMPLETE` → Free-tier entitlements. Keep this rule *only* in `isActive()` (#4) so there's one definition.
- **Local testing:** `stripe listen --forward-to localhost:3000/api/stripe/webhook` + `stripe trigger`.

**Reference:** Stripe Webhooks docs + multiple implementation guides — three guarantees (signature verification, idempotency via stored event ids, fast 200 + async); the subscription event set and status semantics; raw-body requirement for `constructEvent`.

**Effort:** **M** (inline-light) / **L** (queued). Deps: #1, #2; **jobs/webhooks capability** for the queued/reliable variant.

**Tier:** **Foundation** (the system is unsafe without it — it is the sync backbone)

---

## 7. Trials, dunning (failed payments), proration & cancellation flows

**What it enables:** Smooth lifecycle edges — free trials that convert, graceful recovery from failed cards, fair mid-cycle plan/seat changes, and clean cancellations — the difference between a billing system that *charges* and one that *retains*.

**Design:**
- **Trials:** start via Checkout `subscription_data.trial_period_days`. To trial *without* a card, set `payment_method_collection: "if_required"` and `subscription_data.trial_settings.end_behavior.missing_payment_method` = `cancel` (or `pause`). Mirror `trialEndsAt`/`status = TRIALING` locally from the subscription. `customer.subscription.trial_will_end` (fires ~3 days before) → email/notify admins to add a card.
- **Dunning / failed payments:** lean on Stripe-native **Smart Retries** (ML-timed retries, up to 8 over ~2 months; recovers ~57% of failed recurring payments on average) + Stripe's automated dunning emails — *configured in the Dashboard, no code*. Our code's job is the **in-app signal**: on `invoice.payment_failed` set `status = PAST_DUE` and surface a persistent "update your payment method" banner linking to the Billing Portal; define the final outcome (downgrade to Free vs restrict) when Stripe exhausts retries (`customer.subscription.deleted`/`unpaid`).
- **Proration:** for plan upgrades/downgrades and seat changes use `proration_behavior: "create_prorations"` (default, credits/charges the difference) — covered operationally in #3. Plan downgrades that *reduce limits* should be validated against current usage (refuse, or schedule at period end via a subscription schedule) so an org isn't instantly over-limit.
- **Cancellation:** prefer `cancel_at_period_end: true` (access until paid-through date) over immediate cancel; expose both through the Billing Portal so we write no UI. Webhook reflects `cancelAtPeriodEnd`; entitlements stay active until `currentPeriodEnd`.
- **Tax (Stripe Tax):** enable `automatic_tax: { enabled: true }` on Checkout Sessions and subscriptions; Stripe computes tax on initial purchase *and renewals* from the customer's billing/shipping address. Customers manage Tax IDs in the Billing Portal. Mostly configuration — registrations/thresholds are set in the Dashboard, not code.

**Reference:** Stripe Checkout free-trials docs (`trial_period_days`, `payment_method_collection: if_required`, `trial_settings.end_behavior.missing_payment_method`); Smart Retries / revenue-recovery (8 retries / 2 months, ~57% recovery); `proration_behavior` options on subscription update; Stripe Tax `automatic_tax` for subscriptions + renewals.

**Effort:** **M** — mostly Dashboard config + webhook branches + one in-app banner; little bespoke code. Deps: #1, #6.

**Tier:** **Core**

---

## Cross-cutting dependency on jobs/webhooks

Items **#3 (debounced seat sync)**, **#5 (queued meter emission + retries)**, and the reliable variant of **#6 (queued webhook processing)** all assume the **jobs/queue + webhook-intake** capability from that brief. Without it: webhooks can run inline-light (acceptable for single-row updates), seat sync runs inline (accept rate-limit risk on bulk invites), and meter events emit best-effort (accept occasional loss). The queue upgrades all three from "works" to "correct under failure."

---

## Top 3 picks

1. **Webhook handling (#6, Foundation)** — signature-verified + idempotent Stripe→DB sync is the backbone that makes the subscription model, seats, and entitlements *true*. Nothing else is trustworthy without it. Build first.
2. **Plan/Subscription/Entitlement model + `requireFeature`/`withinLimit` helper (#2 + #4, Foundation/Core)** — the org-keyed data model plus the `requireOrg()`-composable gate is the actual paywall; it's where every server action enforces limits and is the highest-leverage primitive in the system.
3. **Stripe Checkout + Billing Portal foundation (#1, Foundation)** — hosted flows get us to "customers can pay and self-manage" with the least code and zero PCI/SCA/tax/invoice-UI burden; it's the on-ramp the other capabilities attach to.
