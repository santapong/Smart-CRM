# Smart-CRM Product Research — Activities, Tasks & Calendar

Focus area: calendar/agenda views, reminders & due-date notifications, recurring tasks, sales sequences/cadences, email & calendar two-way sync UX, meeting scheduler/booking links, activity timelines per record.

Author: Product research (Activities pod) · Date: 2026-06-20

---

## Current state (baseline)

- **Model** (`prisma/schema.prisma`): `Activity { type(TASK/CALL/MEETING/NOTE), title, body, dueAt, completedAt, contactId, dealId, ownerId }`, `@@index([orgId, dueAt])`, `@@index([orgId, completedAt])`. orgId-scoped; `companyId` is **not** on Activity (only contact/deal), so company-level timelines aren't possible yet.
- **Actions** (`src/server/actions/activities.ts`): `createActivity`, `toggleActivityComplete`, `deleteActivity` only. No `updateActivity`, no edit UI. Uses `requireOrg()` + Zod + `ActionResult` (`src/lib/action-result.ts`).
- **UI**: flat list at `src/app/(app)/activities/page.tsx` (take 200, sorted completed→due→created) + inline create form (`activity-form.tsx`, `activity-row.tsx`). Dashboard "Up next" widget = next 8 incomplete by `dueAt`. Per-record "Recent activity" lists already exist on contact (`take: 10`) and deal (`take: 20`) detail pages, but they are plain unsorted lists with no grouping/icons.
- **Infra reality check** (drives effort estimates):
  - **No background job runner / cron / queue** anywhere in repo. Anything time-triggered (reminders, sequence steps, recurrence materialization) needs a new mechanism: Vercel Cron + an authenticated route handler under `src/app/api/`, or a DB-polled worker. This is the single biggest dependency across ideas below.
  - **No email-sending infra** (no Resend/Postmark/Nodemailer dep in `package.json`). Reminders-via-email and sequences need an email provider added.
  - **NextAuth `Account` model already stores `access_token`, `refresh_token`, `expires_at`, `scope`** per provider — a real foundation for Google/Microsoft calendar + email sync (OAuth tokens are already persisted; we'd extend scopes).
  - Stack confirmed: Next 15 App Router + RSC + server actions, React 19, Prisma 5 + Postgres, NextAuth v5, Tailwind + shadcn/Radix, `date-fns` v4 present, `@dnd-kit` present (useful for drag-to-reschedule calendar). No date-picker/calendar component lib yet.

Design principle for all ideas: keep the single `Activity` table as the spine and add satellite tables (recurrence rules, sequences, reminders, sync links) rather than forking new top-level objects, so the per-record timeline stays unified — the way Salesforce, HubSpot, and Pipedrive all converge activities into one timeline.

---

## Ideas

### 1. Calendar / Agenda view (month · week · day + drag-to-reschedule)
**Desc.** A real calendar surface at `src/app/(app)/calendar/` rendering activities with a `dueAt` as events, with Month/Week/Day/Agenda toggles, "today" focus, owner filter, and drag-to-reschedule. The flat list is the #1 obvious gap for a CRM that already captures `dueAt`.

**Competitor evidence.** Pipedrive ships a dedicated [Activity Calendar](https://www.pipedrive.com/en/features/activity-calendar) as a core sales surface, and managers use it to "see how busy team members are and spot free time" before assigning work. Salesforce Lightning replaces related-lists with calendars + the [activity timeline](https://help.salesforce.com/s/articleView?id=sales.activities.htm). A calendar is table stakes for every competitor named.

**Fit with Smart-CRM.**
- Schema: none required for v1 (read existing `Activity.dueAt`). Optional later: add `endAt DateTime?` and `allDay Boolean` to `Activity` to render durations rather than points.
- Server: new `listActivitiesInRange({from,to,ownerId?})` in `activities.ts` (orgId-scoped); reuse `toggleActivityComplete`; add `rescheduleActivity(id, dueAt)` for drag-drop (thin wrapper, the missing update path).
- UI: new route `src/app/(app)/calendar/page.tsx` (RSC fetch by visible range) + client grid; reuse `@dnd-kit` (already a dep) for drag-to-reschedule. Add a "Calendar" nav item in `src/components/app-sidebar.tsx` (`NAV` array, e.g. `CalendarDays` icon).

**Effort.** **M** — build a calendar grid (no calendar lib in deps; either hand-roll with `date-fns` or add one). Deps: `date-fns` (present), optional `rescheduleActivity` action.

**Tier.** **Core.**

---

### 2. Reminders & due-date notifications (in-app + email)
**Desc.** Let users attach reminders to an activity ("remind me 1 day / 1 hour before due") and get notified in-app (bell/notification center) and optionally by email. Includes an automatic "X tasks overdue / due today" digest.

**Competitor evidence.** Zoho CRM lets you be reminded "on the day of the due date or N days/weeks/months before, via Email, Pop Up or Both," at custom intervals (1h, 2h, 1 day before) and repeatable ([Zoho Tasks](https://help.zoho.com/portal/en/kb/crm/sales-force-automation/activities/articles/working-with-tasks-and-meetings)). HubSpot surfaces reminders/notifications in an [activity feed](https://knowledge.hubspot.com/prospecting/view-your-sales-notifications-in-the-activity-feed). This is universally expected.

**Fit with Smart-CRM.**
- Schema: new `Reminder { id, orgId, activityId, userId, remindAt DateTime, method (INAPP|EMAIL|BOTH), sentAt DateTime? }` + `@@index([remindAt, sentAt])`; plus a `Notification { id, orgId, userId, type, title, body, linkUrl, readAt }` table for the in-app center.
- Server: `setReminder/clearReminder` in a new `reminders.ts`; a **due-reminder sweep** job (see infra note) that queries `remindAt <= now AND sentAt IS NULL`, writes `Notification` rows and/or sends email, marks `sentAt`.
- Infra dependency: **Vercel Cron → authenticated `src/app/api/cron/reminders/route.ts`**; email provider (e.g. Resend) for the EMAIL method.
- UI: reminder field in the activity create/edit form; a notification bell in the app shell (`layout.tsx`) with an unread count + dropdown list.

**Effort.** **M** (in-app only) → **L** (with email + cron hardening). Deps: cron runner, optional email provider, depends conceptually on Idea 12 (edit form).

**Tier.** **Core.**

---

### 3. Recurring tasks / activities (RRULE-style recurrence)
**Desc.** Mark an activity as recurring (daily/weekly/monthly/custom, with end date or count). When one instance is completed, the next is generated — so "Weekly check-in with Acme" never falls off the list.

**Competitor evidence.** Salesforce: check "recurring," define frequency + expiry; "once a recurring task is completed, a new task is created automatically" ([SF recurring tasks](https://help.salesforce.com/s/articleView?language=en_US&id=sf.tasks_enable_recurring_tasks_lex.htm)). Zoho recurring tasks repeat daily/weekly/monthly/yearly/custom, indefinitely or for a period ([Zoho](https://help.zoho.com/portal/en/community/topic/setting-recurring-tasks-and-reminders-are-enhanced-in-zoho-crm)).

**Fit with Smart-CRM.**
- Schema: `RecurrenceRule { id, orgId, freq (DAILY|WEEKLY|MONTHLY), interval Int, byWeekday Int[]?, until DateTime?, count Int? }` referenced by `Activity.recurrenceRuleId String?` + a `seriesId String?` on Activity to group instances. Materialize-on-complete (simplest) or roll-forward via the same cron as reminders.
- Server: extend `createActivity` to accept a recurrence; on `toggleActivityComplete`, if the activity has a rule and isn't past `until`, spawn the next instance (compute next date with `date-fns`).
- UI: recurrence picker in the form ("Repeats: never / daily / weekly on … / monthly"); a small "↻ repeats weekly" badge in `activity-row.tsx` and on the calendar.

**Effort.** **M.** Deps: `date-fns` (present); shares the edit-form work (Idea 12) and optionally the cron sweep (Idea 2) for time-based generation. Avoid a full RFC-5545 RRULE library for v1 — support the 3 common freqs.

**Tier.** **Core.**

---

### 4. Sales sequences / cadences (multi-step automated follow-up)
**Desc.** Define a reusable sequence of timed steps (Day 0 email, Day 2 call task, Day 5 email, Day 9 LinkedIn task…). Enroll a contact/deal; the engine auto-creates the right `Activity` (task) or sends/queues the email at each step, advances on a schedule, and **auto-pauses when the prospect replies**. The flagship "platform" feature.

**Competitor evidence.** HubSpot Sequences mix automated emails + call/LinkedIn tasks + reminders, "pause when a prospect replies," support inbound vs outbound enrollment and bulk enroll (up to 50), with workflow-based auto-enrollment on Enterprise ([HubSpot create sequences](https://knowledge.hubspot.com/sequences/create-and-edit-sequences), [enroll](https://knowledge.hubspot.com/sequences/enroll-contacts-in-a-sequence)). Known limits worth beating: max 50 manual enrollees and a contact can only be in one sequence at a time ([RevPartners 2025 guide](https://blog.revpartners.io/en/revops-articles/hubspot-sales-sequences-setup-guide-best-practices-2025)).

**Fit with Smart-CRM.**
- Schema: `Sequence { id, orgId, name, isActive }`, `SequenceStep { id, sequenceId, order, dayOffset Int, type (EMAIL|TASK|CALL), templateId?, taskTitle? }`, `SequenceEnrollment { id, orgId, sequenceId, contactId?, dealId?, ownerId, status (ACTIVE|PAUSED|FINISHED|REPLIED), currentStep, nextRunAt DateTime }` + `@@index([status, nextRunAt])`. Email steps reuse the email infra (Idea 8); task/call steps create `Activity` rows tying everything back into the unified timeline.
- Server: new `sequences.ts` — `createSequence`, `enrollInSequence`, `unenroll`, and a `runSequenceStep` worker invoked by cron that processes `nextRunAt <= now`.
- Infra dependency: cron runner + email provider; reply-detection depends on inbound email/calendar sync (Idea 8) to flip `status=REPLIED`.
- UI: `src/app/(app)/sequences/` (list + builder with `@dnd-kit` for step ordering); "Enroll in sequence" action on contact/deal detail; enrollment status chip on the contact timeline.

**Effort.** **L** (largest item; depends on email infra + cron + reply detection). Deps: Ideas 2 (cron), 8 (email send/receive), 12 (edit infra).

**Tier.** **Strategic Bet.**

---

### 5. Two-way Google / Microsoft calendar sync
**Desc.** Connect a Google or Outlook calendar; MEETING activities with times push out as calendar events, and external events sync in as activities. Edits in either side reconcile. Includes a "free/busy" signal so the scheduler (Idea 6) never double-books.

**Competitor evidence.** Pipedrive offers one- or two-way Outlook/Google sync where "edits in either calendar update the linked event/activity in the other," with control over visibility of synced external events and private-event handling ([Pipedrive calendar sync](https://support.pipedrive.com/en/article/calendar-sync)). Freshsales links Gmail/M365 with one- or two-way sync ([folk comparison](https://www.folk.app/articles/HubSpot-vs-Freshsales-email-integration)).

**Fit with Smart-CRM.**
- Schema: `CalendarConnection { id, orgId, userId, provider, externalCalendarId, syncToken?, lastSyncedAt }` and `Activity.externalEventId String?` + `Activity.endAt` to map durations. **NextAuth `Account` already stores OAuth `access_token`/`refresh_token`/`scope`** — extend the Google/Microsoft scopes to include Calendar and reuse those tokens.
- Server: new `calendar-sync.ts` — push on `createActivity`/reschedule for MEETING types; pull via provider API on a cron tick using `syncToken` (incremental). Handle token refresh.
- Infra dependency: cron runner; provider API clients (Google Calendar API / Microsoft Graph); extended OAuth scopes + consent screen.
- UI: "Connect calendar" in `src/app/(app)/settings/`; per-activity "synced ✓/conflict" indicator; sync settings (visibility of external events, which calendar).

**Effort.** **L.** Deps: extended NextAuth scopes, Google/MS Graph clients, cron, `endAt` field.

**Tier.** **Strategic Bet.**

---

### 6. Meeting scheduler / booking links (Calendly-style)
**Desc.** Each user (and team) gets a public booking page `/(public)/book/[slug]`. Define event types (15/30/60-min), working hours, buffers, min-notice, daily caps; invitees pick a slot; on booking we create a MEETING `Activity` (+ contact if new) and push to the connected calendar. Optional team **round-robin** assignment.

**Competitor evidence.** Calendly: connect calendar, share link, invitees pick from real-time availability; [buffers](https://calendly.com/scheduling/availability) before/after, block last-minute bookings, daily/weekly/monthly caps; [round-robin](https://calendly.com/help/round-robin-distribution-overview) assigns by availability/priority/even distribution. Pipedrive bundles a [Scheduler](https://www.pipedrive.com/en/products/sales/scheduling-tool) that auto-generates the meeting link, sends the invite, and logs notes to the activity; "Busy" activities block bookable slots.

**Fit with Smart-CRM.**
- Schema: `BookingType { id, orgId, ownerId|teamRoundRobin, slug, durationMin, bufferBeforeMin, bufferAfterMin, minNoticeMin, maxPerDay? }`, `AvailabilityRule { bookingTypeId, weekday, startMin, endMin }`, `Booking { id, orgId, bookingTypeId, inviteeName, inviteeEmail, startAt, endAt, activityId, contactId }`.
- Server: new `booking.ts` — `getAvailableSlots` (compute from rules minus existing busy activities/synced events), `createBooking` (creates Activity + Contact + optional calendar push + round-robin pick). Public route handler for unauthenticated slot fetch/book.
- Infra dependency: best paired with Idea 5 (free/busy) to avoid double-booking; email provider for confirmations; cron not strictly required.
- UI: settings to define booking types + availability; **public** booking page (new route group `src/app/(public)/book/[slug]/`, no `requireOrg`); "Copy booking link" on the user/settings page.

**Effort.** **L** (standalone availability engine + public surface). **M** if launched as single-user only without round-robin/calendar conflict-checking. Deps: email provider; Idea 5 for accuracy.

**Tier.** **Strategic Bet** (full) / its single-user MVP could ship as **Core**.

---

### 7. Per-record activity timeline (grouped, typed, chronological)
**Desc.** Upgrade the plain "Recent activity" lists on contact/deal (and a new company) detail pages into a true timeline: reverse-chronological, **date-bucketed** (Today / Yesterday / This week / Earlier), type icons (call/meeting/email/note/task), completed vs upcoming split, "log activity" inline composer, and "show more". This is the connective tissue that makes every other idea visible in context.

**Competitor evidence.** Salesforce Lightning's [activity timeline](https://help.salesforce.com/s/articleView?id=xcloud.lex_pro_tips_activity_timeline.htm) bundles "every task, meeting, logged call, and sent email" into scannable summaries of past/present/future per record. HubSpot records opens/clicks/logged emails "on the record's timeline" ([HubSpot tracking](https://knowledge.hubspot.com/connected-email/understand-hubspot-sales-email-open-and-click-tracking)).

**Fit with Smart-CRM.**
- Schema: **add `companyId String?` to `Activity`** (+ relation + `@@index([orgId, companyId])`) so company pages get a timeline and a contact's company rolls up its people's activity. No other change.
- Server: `listTimeline({ contactId?|dealId?|companyId? })` returning grouped/ordered results; or just enrich existing detail-page queries with ordering + the new composer using `createActivity` with `defaultContactId`/`defaultDealId` (the form already accepts these props).
- UI: a shared `<ActivityTimeline>` component reused on contact (`src/app/(app)/contacts/[id]/page.tsx`), deal (`deals/[id]/page.tsx`), and a new company timeline section; type icons via `lucide-react` (already used).

**Effort.** **S–M.** Deps: tiny schema add (`companyId`); reuses existing form/actions.

**Tier.** **Quick Win** (the visual upgrade) / **Core** (with company rollup).

---

### 8. Email send + tracking, logged to the timeline (open/click)
**Desc.** Send email to a contact from within Smart-CRM (or BCC-to-CRM / connected-inbox capture), log it as an EMAIL activity on the timeline, and **track opens & link clicks** with a real-time notification. Foundational for sequences (Idea 4) and reply-detection.

**Competitor evidence.** HubSpot notifies you when a contact opens/clicks, records the event "in the contact's activity timeline" and "in the activity feed," wrapping links with tracking URLs and using a pixel for opens; it distinguishes **Track** (engagement) vs **Log** (store a copy on the record) ([HubSpot email tracking](https://knowledge.hubspot.com/connected-email/understand-hubspot-sales-email-open-and-click-tracking)). Freshsales offers open/click tracking + shared timelines ([comparison](https://www.folk.app/articles/HubSpot-vs-Freshsales-email-integration)).

**Fit with Smart-CRM.**
- Schema: extend `Activity` for EMAIL (`direction`, `emailMessageId`, `openedAt`, `clickedAt`, `bouncedAt`) or a satellite `EmailEvent { activityId, kind (OPEN|CLICK), at, meta }`. Add `EMAIL` to the `ActivityType` enum.
- Server: `sendEmail` action (via email provider) that creates the EMAIL activity; public **tracking route handlers** `src/app/api/track/open/[id]/route.ts` (1×1 pixel) and `/track/click/[id]` (redirect) that stamp timestamps + write a `Notification`.
- Infra dependency: email provider (send) + inbound parsing/webhook for replies; tokens already in `Account` if using connected-inbox approach.
- UI: "Email" composer on contact detail; open/click chips on the timeline; notification on engagement.

**Effort.** **L** (send + inbound + tracking endpoints). A **send-only + open-pixel** slice is **M**. Deps: email provider; enables Ideas 4 & 5 reply detection.

**Tier.** **Strategic Bet.**

---

### 9. "My Day" / Today focus workspace with task queues
**Desc.** A focused daily cockpit: Overdue, Due today, Upcoming, plus the ability to group tasks into **queues** ("Morning calls", "Renewal outreach") and work them one-by-one (queue → next contact → log outcome → next) without hunting through the CRM. Turns the flat list into a productivity loop.

**Competitor evidence.** HubSpot [task queues](https://www.octavehq.com/post/hubspot-tasks-queues-managing-sales-activity) let reps "focus on one task at a time without switching tabs," sorted by due date, started with one click — "eliminates the cognitive overhead of deciding what to do next." Pipedrive frames activities + goals as the daily driver ([Activities & Goals](https://www.pipedrive.com/en/features/activities-goals)).

**Fit with Smart-CRM.**
- Schema: optional `TaskQueue { id, orgId, ownerId, name, order }` + `Activity.queueId String?`; the Overdue/Today/Upcoming split needs **no** schema (derive from `dueAt`/`completedAt`).
- Server: `listMyDay()` returning the three buckets + queues, all `ownerId`-scoped; `assignToQueue(activityId, queueId)`.
- UI: replace/augment `src/app/(app)/activities/page.tsx` with a tabbed "My Day" default view; a "focus mode" panel that walks a queue with a log-outcome step.

**Effort.** **S** (buckets-only, derived) → **M** (with named queues + focus walker). Deps: none for the buckets MVP; pairs with Idea 11 (outcomes).

**Tier.** **Quick Win** (buckets) / **Core** (queues + focus mode).

---

### 10. Custom activity types + per-type configuration
**Desc.** Let admins define org-specific activity types beyond the 4 hard-coded enum values (e.g. "Demo", "Lunch", "QBR", "Site visit") with their own icon/color, instead of the fixed `TASK/CALL/MEETING/NOTE`.

**Competitor evidence.** Pipedrive ships preset types (call, meeting, task, deadline, email, lunch) **and** lets you "create as many custom activity types as you need" to fit your process ([Pipedrive activities](https://support.pipedrive.com/en/article/activities)). Salesforce allows activity-enabled custom objects across the timeline.

**Fit with Smart-CRM.**
- Schema: introduce `ActivityTypeDef { id, orgId, key, label, icon, color, isSystem }` and migrate `Activity.type` from the enum to a `typeId` FK (seed the 4 defaults per org). This is a **migration of the existing enum** — touch points: the Zod schema in `activities.ts`, the `<select>` in `activity-form.tsx`, and the type-badge rendering everywhere.
- Server: type CRUD in `org.ts`/new `activity-types.ts`; update `activitySchema` to validate against org types instead of a fixed enum.
- UI: settings section to manage types; type picker becomes data-driven.

**Effort.** **M** (enum→table migration ripples through form, schema, and badges). Deps: settings UI patterns (exist).

**Tier.** **Core** (high config value, but enum migration is real work).

---

### 11. Call & meeting outcomes / dispositions
**Desc.** When completing a CALL/MEETING, capture a structured outcome (Connected, Left voicemail, No answer, **No-show**, Rescheduled, Not interested) plus optional notes. Powers activity reporting ("connect rate", "no-show rate") and clean sequence branching.

**Competitor evidence.** Pipedrive's recommended pattern is either a dedicated "Meeting – no show" type or a "Meeting outcome" dropdown (incl. "No Show") to report and segment by outcome; integrations sync call **disposition codes** to activities ([Pipedrive outcomes](https://community.pipedrive.com/discussion/8783/), [JustCall dispositions](https://help.justcall.io/en/articles/2135920-sync-call-outcomes-or-disposition-codes-with-pipedrive-activities)).

**Fit with Smart-CRM.**
- Schema: add `Activity.outcome String?` (or enum `ActivityOutcome`) + optional `outcomeNote`; orgs could later customize the allowed set (ties to Idea 10).
- Server: extend `toggleActivityComplete` (or a new `completeActivity(id, outcome?)`) to persist the outcome at completion.
- UI: when marking a CALL/MEETING complete, show a small outcome picker (the `activity-row` completion button gains a popover for those types); outcome chip on the timeline.

**Effort.** **S.** Deps: pairs naturally with Idea 9 focus mode and Idea 7 timeline; minimal schema.

**Tier.** **Quick Win.**

---

### 12. Editable activities + quick-add / inline reschedule (table-stakes UX)
**Desc.** The current actions support create/toggle/delete but **no edit**. Add `updateActivity` and an edit dialog, plus a natural-language-ish quick-add ("Call Acme tomorrow 3pm") and inline reschedule from list/calendar. This is the foundation several other ideas quietly depend on.

**Competitor evidence.** Every competitor treats activity edit/reschedule as baseline; Pipedrive emphasizes fast logging and rescheduling in its [activities](https://support.pipedrive.com/en/article/activities) module, and HubSpot's [task workspace](https://www.octavehq.com/post/hubspot-tasks-queues-managing-sales-activity) is built around quick edits and one-click rescheduling. (Gap-closing rather than novel.)

**Fit with Smart-CRM.**
- Schema: none.
- Server: add `updateActivity(id, input)` in `activities.ts` (mirror `createActivity`'s Zod schema + `requireOrg` ownership check via `findFirst({where:{id,orgId}})`); add `rescheduleActivity(id, dueAt)` shared with the calendar (Idea 1).
- UI: reuse `activity-form.tsx` inside a shadcn `Dialog` (already a dep) for edit; add a quick-add input to the activities page / command palette (`src/components/command-palette.tsx` exists).

**Effort.** **S.** Deps: none — unblocks Ideas 1, 2, 3.

**Tier.** **Quick Win.**

---

## Effort × tier summary

| # | Idea | Effort | Tier |
|---|------|--------|------|
| 1 | Calendar / agenda view + drag-reschedule | M | Core |
| 2 | Reminders & due-date notifications | M→L | Core |
| 3 | Recurring tasks (RRULE-lite) | M | Core |
| 4 | Sales sequences / cadences | L | Strategic Bet |
| 5 | Two-way Google/Microsoft calendar sync | L | Strategic Bet |
| 6 | Meeting scheduler / booking links | L (M MVP) | Strategic Bet |
| 7 | Per-record activity timeline (grouped) | S–M | Quick Win→Core |
| 8 | Email send + open/click tracking | L (M slice) | Strategic Bet |
| 9 | "My Day" focus + task queues | S→M | Quick Win→Core |
| 10 | Custom activity types | M | Core |
| 11 | Call/meeting outcomes | S | Quick Win |
| 12 | Editable activities + quick-add | S | Quick Win |

**Cross-cutting dependency:** Ideas 2, 4, 5 (and the richer slices of 6, 8) all need a **time-triggered job runner** (Vercel Cron + authenticated `src/app/api/cron/*` route, or a polling worker) and Ideas 4/6/8 need an **email provider** — neither exists today. Sequencing these two infra investments first de-risks the whole roadmap. The `Account` table already persisting OAuth tokens/scopes is a real head start for Ideas 5 and 8.

---

## Top 3 picks

1. **Per-record activity timeline + editable activities (Ideas 7 + 12)** — the cheapest, highest-leverage move. Adds `Activity.companyId`, an `updateActivity` action, and a reusable grouped `<ActivityTimeline>` on contact/deal/company. Closes glaring UX gaps (no edit, no grouping, no company view), is S–M effort with no new infra, and is the canvas every later feature renders into. Ship first.

2. **Calendar / agenda view with drag-to-reschedule (Idea 1)** — the single most visible missing feature vs Pipedrive/Salesforce, and the data (`dueAt`) is already there. M effort, reuses the `@dnd-kit` dep, and pairs perfectly with #1's `rescheduleActivity`. Highest "this feels like a real CRM" payoff per unit effort.

3. **Reminders & recurring tasks, on a new cron runner (Ideas 2 + 3)** — done together because they share the time-triggered job infrastructure that also unlocks the Strategic Bets (sequences, calendar sync). Delivers the universally-expected "remind me before due" + "repeat weekly" behaviors (Zoho/Salesforce parity) while standing up the cron + notification foundation the platform roadmap depends on.
