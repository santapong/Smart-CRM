# Smart-CRM Product Research — 05. Collaboration & Team Productivity

**Author:** Senior Product Researcher (Collaboration & team productivity)
**Date:** 2026-06-20
**Scope:** @mentions, comments/threads on records, shared & saved views, in-app notifications & notification center, activity/change feed (per record & per org), assignment & ownership handoff, mobile/responsive experience.
**Status:** RESEARCH ONLY — no repo changes.

---

## Context: where Smart-CRM is today

The collaboration surface is essentially empty, which is both the risk and the opportunity. From the repo:

- **Records have a single `ownerId`** (`Deal.ownerId`, `Activity.ownerId`) and nothing else collaborative. `Company`/`Contact` have no owner at all (`prisma/schema.prisma`).
- **Membership/roles exist** (`OWNER`/`ADMIN`/`MEMBER`) and are managed in Settings (`src/app/(app)/settings/members-section.tsx`, `src/server/actions/org.ts`), but roles only gate org-admin actions.
- **No notifications, no comments, no @mentions, no shared/saved views, no change feed.** `Activity` is a *task/call/meeting/note* business object (something a user schedules), **not** an audit/event log — so there is no "who changed what" trail.
- **Sidebar is desktop-only** — `src/components/app-sidebar.tsx` renders `<aside className="hidden md:flex …">`. On phones there is literally no navigation. The app layout (`src/app/(app)/layout.tsx`) renders only the sidebar + `<main>`; no header, no mobile drawer.
- List pages bake filters into URL `searchParams` (e.g. `?q=&tag=` in `src/app/(app)/contacts/page.tsx`) but there is no way to *save* a filter combination.

**Established patterns to reuse (important for "fit" below):**
- Server actions in `src/server/actions/*.ts`, `"use server"`, Zod-validated, returning `ActionResult<T>` (`src/lib/action-result.ts`), calling `revalidatePath()`.
- Tenancy via `requireOrg()` → `{ userId, orgId, role }` (`src/lib/tenant.ts`); **every query is `orgId`-scoped**.
- RBAC via `requireRole(role, "ADMIN")` (`src/lib/rbac.ts`).
- Session JWT already carries `activeOrgId` + `role` (`src/lib/auth.ts`) — a notification badge can read this without extra plumbing.
- Detail pages are RSC with `Promise.all` parallel queries + an aside column (`src/app/(app)/deals/[id]/page.tsx`) — a natural slot for a comments/activity panel.
- Toasts via `sonner`; forms via shadcn/Radix.

**Competitor baseline (the bar we're measuring against):** HubSpot, Salesforce (Chatter), Pipedrive, and Zoho all treat record-level collaboration — comments + @mentions + a notification center + a per-record timeline + follow/subscribe — as **table stakes**, not premium. Pipedrive shipped mentions/comments as one of its "first steps toward team collaboration." HubSpot puts comments and @mentions directly on the record timeline and notifies owners + mentioned users. This is the gap Smart-CRM must close to be credible for teams.

---

## Ideas

### 1. Record Comments (threaded notes on any record)

**Description.** A comment composer + thread on each Contact/Company/Deal detail page (and optionally Activity). Plain-text/lightweight-markdown comments, newest-or-oldest ordering, edit/delete-own, author + relative timestamp. This is the substrate that @mentions, notifications, and the activity feed all build on, so it ships first.

**Competitor evidence.** HubSpot lets you "add comments that include @mentions" on contact, company, deal, and ticket records, and these "become part of the record's activity timeline" ([HubSpot mentions](https://hubspot.com/product-updates/crm-team-collaboration-mentions), [activity comments guide](https://consultevo.com/hubspot-activity-comments-how-to/)). Pipedrive supports comments on notes for "leads, deals, contact people, organizations and projects" ([Pipedrive mentions & comments](https://support.pipedrive.com/en/article/mentions-and-comments-beta)). Salesforce Chatter is built around posts + comments on records ([Salesforce Ben Chatter guide](https://www.salesforceben.com/salesforce-chatter/)).

**Fit with Smart-CRM.**
- **Schema:** new polymorphic-ish `Comment` model. Given Prisma + Postgres and only 3-4 record types, the clean approach is an `entityType` enum + `entityId` string, all `orgId`-scoped:
  ```
  enum CommentEntity { CONTACT COMPANY DEAL ACTIVITY }
  model Comment {
    id String @id @default(cuid())
    orgId String
    entityType CommentEntity
    entityId   String
    authorId   String
    body       String @db.Text
    editedAt   DateTime?
    createdAt  DateTime @default(now())
    org    Organization @relation(...)
    author User         @relation(...)
    mentions Mention[]   // see idea #2
    @@index([orgId, entityType, entityId, createdAt])
  }
  ```
- **Server actions:** `src/server/actions/comments.ts` → `createComment`, `editComment`, `deleteComment`. All `requireOrg()`-scoped; validate that `entityId` belongs to `orgId` before insert (reuse the existing "fetch-by-id-and-orgId then fail if null" pattern from `activities.ts`). Delete = own comment OR `ADMIN`+. `revalidatePath` the record page.
- **UI:** `src/components/comments/comment-thread.tsx` (server) + `comment-composer.tsx` (client, `useTransition`, sonner). Drop into the `<aside>` slot already present in `deals/[id]/page.tsx`; add equivalent to contact/company detail pages.

**Effort:** **M.** Deps: none (foundation). Everything else collaborative depends on this.
**Tier:** **Free / core** (table stakes).

---

### 2. @Mentions with autocomplete

**Description.** Typing `@` in a comment composer opens a typeahead of org members; selecting one inserts a mention token. On submit, mentioned users get an in-app notification (#4) and the mention renders as a styled chip linking to that person. Respects tenancy — you can only mention members of the current org.

**Competitor evidence.** Universal. HubSpot: "start typing '@' and the user's name … list of users appears," sending in-app + email notification ([INSIDEA guide](https://insidea.com/blog/hubspot/kb/how-to-mention-users-and-collaborate-on-records-in-hubspot/)). Pipedrive: "tag your colleagues in your notes using mentions … users mentioned receive a notification" ([Pipedrive KB](https://support.pipedrive.com/en/article/mentions-and-comments-beta)). Salesforce Chatter: "@mention a person or a group to call their attention" and crucially **enforces sharing rules** — mentioning someone without record access shows a gray, non-notifying link ([Salesforce @mention help](https://help.salesforce.com/s/articleView?id=collab_add_mentioning_people.htm), [visibility](https://help.salesforce.com/s/articleView?id=experience.collab_mention_visibility.htm)). Smart-CRM's simpler flat org model means everyone in an org can see all org records, so we can skip per-record access checks for v1 — but should still scope mentions to org members.

**Fit with Smart-CRM.**
- **Schema:** `Mention` join row so notifications/queries are cheap and we don't re-parse bodies:
  ```
  model Mention {
    id String @id @default(cuid())
    commentId String
    userId    String   // mentioned user
    comment Comment @relation(fields:[commentId], references:[id], onDelete: Cascade)
    user    User    @relation(fields:[userId],   references:[id])
    @@unique([commentId, userId])
  }
  ```
  Store mention tokens in `Comment.body` as `@[Name](userId)` (markdown-ish) so rendering is deterministic.
- **Server actions:** extend `createComment` to parse mention tokens, validate each `userId` has a `Membership` in `orgId`, create `Mention` rows, and fan out notifications (#4) — all inside the existing `db.$transaction` style used in `org.ts`.
- **UI:** mention-autocomplete in `comment-composer.tsx`. Member list comes from a tiny server action (`listOrgMembers`) or is passed as a prop from the RSC page. Render with a `<MentionChip>`; reuse `cn()` + badge styling from `src/components/ui/badge.tsx`.

**Effort:** **M.** Deps: #1 (comments), #4 (notifications) for the payoff.
**Tier:** **Free / core** (table stakes; the #1 reason teams ask for collaboration).

---

### 3. In-App Notification Center (bell + dropdown + page)

**Description.** A bell icon with an unread-count badge in a (new) top app header, opening a dropdown of recent notifications; plus a full `/notifications` page. Each notification links to its source (the commented deal, the assigned contact). Actions: mark-one-read, mark-all-read, click-to-navigate (auto-marks read). This is the home for mentions, assignments, and follows.

**Competitor evidence.** Every competitor has a bell. Pipedrive: "lightbulb icon in the top-right corner" opens the notifications panel ([Pipedrive notifications](https://support.pipedrive.com/en/article/notifications)). Zoho: "Notifications icon (bell) on the top-right" ([Zoho Signals](https://www.zoho.com/crm/developer/docs/signals/)). UX best practices: provide **mark-all-as-read**, keep the entry point in a "predictable, easy-to-spot location," and give state management (read/unread/clicked) ([Courier notification-center guide](https://www.courier.com/guides/how-to-build-a-notification-center/chapter-3-best-practices-for-notification-centers), [equal.design](https://www.equal.design/blog/in-app-notifications-best-practices-for-saas)).

**Fit with Smart-CRM.**
- **Schema:**
  ```
  enum NotificationType { MENTION COMMENT ASSIGNMENT STAGE_CHANGE FOLLOW_ACTIVITY MEMBER_JOINED }
  model Notification {
    id String @id @default(cuid())
    orgId String
    userId String      // recipient
    type   NotificationType
    title  String       // denormalized for cheap render
    body   String?
    linkPath String?    // e.g. /deals/abc123
    actorId String?     // who caused it
    entityType String?  // for grouping/dedupe
    entityId   String?
    readAt DateTime?
    createdAt DateTime @default(now())
    org  Organization @relation(...)
    user User         @relation(...)
    @@index([userId, readAt, createdAt])
  }
  ```
- **Server actions:** `src/server/actions/notifications.ts` → `markRead(id)`, `markAllRead()`, `listNotifications({cursor})`, `getUnreadCount()`. A reusable internal helper `notify({userId, type, ...})` is called from comment/assignment/follow code paths.
- **UI:** **first introduce a shared `AppHeader`** in `src/app/(app)/layout.tsx` (currently there is none — also unblocks #9 mobile nav). Add `src/components/notifications/notification-bell.tsx` (client; reads count). The unread count can poll on an interval or refresh on navigation — no websocket infra needed for v1 (Server Actions + `router.refresh()`), keeping it within the current stack. Full page at `src/app/(app)/notifications/page.tsx` (RSC list).
- **Delivery channel note:** v1 = in-app only. Email digests are idea #10.

**Effort:** **M** (L if real-time/websockets — recommend deferring; poll-on-focus is fine). Deps: #1/#2 produce the notifications; the `AppHeader` is shared with #9.
**Tier:** **Free / core.**

---

### 4. Mention & Comment Notifications (the wiring)

**Description.** The event→notification fan-out: when you're @mentioned, you get a `MENTION` notification; when someone comments on a record you own or follow (#6), you get a `COMMENT` notification (deduped/grouped so a 5-comment thread isn't 5 pings). Owners of a record are notified of comments by default (HubSpot's model).

**Competitor evidence.** HubSpot sends comment-notification emails "to asset owners and mentioned users" ([HubSpot comment notifications](https://knowledge.hubspot.com/campaigns/comment-notification-emails)). For deals you can be notified "when you're @-mentioned" and "when a deal you own or follow moves stage" ([HubSpot follow a record](https://knowledge.hubspot.com/crm-setup/follow-a-record)). Grouping guidance: "rather than notifying about each comment in a thread, send a single update summarizing the activity" ([Smashing Magazine notifications](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)).

**Fit with Smart-CRM.** This is mostly *logic*, not new screens. Implement `notify()` calls inside `createComment` (after #1/#2). Dedupe rule: if an unread `COMMENT` notification already exists for the same `(userId, entityType, entityId)`, update its timestamp/title ("3 new comments on …") instead of inserting a new row — cheap with the `@@index([userId, …])` above. Self-notifications suppressed (don't notify the actor).

**Effort:** **S** (assuming #1–#3 exist). Deps: #1, #2, #3.
**Tier:** **Free / core.**

---

### 5. Per-Record Activity / Change Feed (audit timeline)

**Description.** A chronological, system-generated timeline on each record: "Sarah changed Stage from *Proposal* → *Negotiation*," "Deal created by Tom," "Owner changed to Maya," interleaved with comments. Distinct from the existing `Activity` business object — this is an immutable **event log**. Shows who/what/when, with old→new values for field edits.

**Competitor evidence.** HubSpot "logs every property change, association modification, and activity on the record's timeline," letting you see "previous values, sources of change, and timestamps" ([HubSpot work with records](https://knowledge.hubspot.com/records/work-with-records), [view activity history](https://knowledge.hubspot.com/records/view-the-history-of-an-activity-on-a-record)). A CRM audit trail is "a chronological … record of every user action, data change … capturing who changed what, when" ([Vantage Point audit trails](https://vantagepoint.io/blog/sf/building-audit-trails-crm-compliance-guide)). Salesforce surfaces record updates in the Chatter feed when feed tracking is enabled ([Salesforce Ben](https://www.salesforceben.com/salesforce-chatter/)).

**Fit with Smart-CRM.**
- **Schema:** an append-only `RecordEvent` (avoid the name `Activity`, already taken):
  ```
  enum RecordEventType { CREATED UPDATED FIELD_CHANGED STAGE_CHANGED OWNER_CHANGED STATUS_CHANGED COMMENTED DELETED }
  model RecordEvent {
    id String @id @default(cuid())
    orgId String
    entityType CommentEntity   // reuse enum from #1
    entityId   String
    type RecordEventType
    actorId String?
    field   String?            // e.g. "stageId"
    oldValue String?
    newValue String?
    createdAt DateTime @default(now())
    @@index([orgId, entityType, entityId, createdAt])
    @@index([orgId, createdAt])   // powers the org-wide feed, idea #8
  }
  ```
- **Server actions:** add a small `logEvent()` helper and call it from the **existing** mutation actions (`deals.ts`, `contacts.ts`, `companies.ts`). The biggest cost is diffing changed fields in update actions — do it once with a shared `diffFields(before, after, watched[])` util. No UI for writing; it's automatic.
- **UI:** `src/components/activity-feed/record-feed.tsx` (RSC) merging `RecordEvent` + `Comment` into one timeline in the record aside. Reuses the timeline layout pattern.

**Effort:** **M** (the diffing + touching every mutation action). Deps: enum shared with #1; ideally land with comments so the timeline is unified.
**Tier:** **Free / core** for the timeline; **field-level history retention** (long-window) can be a paid tier later (HubSpot gates deep audit logs to Enterprise).

---

### 6. Follow / Subscribe to a Record

**Description.** A "Follow" toggle on any record. Following a record means you get notifications for new activity on it (comments, stage changes, owner changes) even if you don't own it. Owners auto-follow their records.

**Competitor evidence.** HubSpot: "follow a contact, company, ticket, deal … to receive notifications when there is new activity," via Actions → Follow/Unfollow ([HubSpot follow a record](https://knowledge.hubspot.com/crm-setup/follow-a-record)). For deals, followers get stage-change and mention notifications ([HubSpot user notifications](https://knowledge.hubspot.com/user-management/how-to-set-up-user-notifications-in-hubspot)). Salesforce Chatter's "What I Follow" feed is the same primitive ([Salesforce @mention help](https://help.salesforce.com/s/articleView?id=collab_add_mentioning_people.htm)). Pipedrive notifies on "items you own or follow" ([Pipedrive community](https://community.pipedrive.com/discussion/1091/mentions-in-notes-beta-testing)).

**Fit with Smart-CRM.**
- **Schema:**
  ```
  model Follow {
    id String @id @default(cuid())
    orgId String
    userId String
    entityType CommentEntity
    entityId   String
    createdAt DateTime @default(now())
    @@unique([userId, entityType, entityId])
    @@index([orgId, entityType, entityId])
  }
  ```
- **Server actions:** `toggleFollow(entityType, entityId)` in `notifications.ts` or a new `follows.ts`. The `notify()` fan-out in #4/#5 now also queries `Follow` rows for the entity (minus the actor) and notifies each follower.
- **UI:** a `<FollowButton>` (client) in each record's `PageHeader` actions slot (the `deals/[id]` header already accepts children). Optionally a "Following" saved view (#7) listing everything you follow.

**Effort:** **S–M.** Deps: #3 (notifications), #5 (events to react to).
**Tier:** **Free / core.**

---

### 7. Saved & Shared Views (filtered lists with visibility)

**Description.** Let users save a named combination of filters + columns + sort on the Contacts/Companies/Deals lists (e.g. "My open deals closing this month," "Contacts with no owner"). Each view has a **visibility**: Private / Team (org) / shared default. A view switcher sits atop each list. Views are live filters, not snapshots.

**Competitor evidence.** HubSpot saved views = "a reusable set of filters and visible columns" with visibility "everyone, your team, or private," and they "redraw in real time as your data changes" ([HubSpot saved views](https://knowledge.hubspot.com/records/create-and-manage-saved-views), [INSIDEA](https://insidea.com/blog/hubspot/kb/how-to-create-and-manage-saved-views-in-hubspot-crm)). This is core to how reps and managers monitor team pipeline.

**Fit with Smart-CRM.**
- **Schema:**
  ```
  enum ViewScope { CONTACT COMPANY DEAL ACTIVITY }
  enum ViewVisibility { PRIVATE ORG }
  model SavedView {
    id String @id @default(cuid())
    orgId String
    ownerId String
    scope ViewScope
    name String
    visibility ViewVisibility @default(PRIVATE)
    config Json          // { filters, columns, sort } — serialized URL/search state
    isDefault Boolean @default(false)
    createdAt DateTime @default(now())
    @@index([orgId, scope])
  }
  ```
- **Server actions:** `saveView`, `updateView`, `deleteView`, `setDefaultView` in `src/server/actions/views.ts`. ORG-visibility views editable only by owner or `ADMIN`+ (reuse `requireRole`).
- **UI:** The list pages already serialize state into `searchParams` (`contacts/page.tsx` uses `?q=&tag=`). A `SavedView.config` is essentially that querystring persisted. Add a `<ViewSwitcher>` dropdown to each list's `PageHeader`; selecting a view pushes its `searchParams`. Lowest-friction because it rides the existing URL-driven filtering — **biggest UX leverage relative to effort.**

**Effort:** **M.** Deps: none hard (independent of the comments stack). Benefits from #9 for mobile.
**Tier:** Private views **Free**; **Team/shared views = paid tier** (classic per-seat upsell; HubSpot reserves richer view sharing for paid).

---

### 8. Org-Wide Activity Feed ("What's happening")

**Description.** A team-level firehose/dashboard feed: recent comments, mentions, deals won/lost, new contacts, ownership changes across the whole org — a "pulse" for managers and a stand-in for a standup. Filterable by member, type, or record type.

**Competitor evidence.** Zoho's **Feeds** "serves as a collaborative platform" surfacing team activity, shown under Notifications ([Zoho Signals](https://www.zoho.com/crm/developer/docs/signals/)). Salesforce Chatter's main feed and "To Me / What I Follow" feeds are the org-pulse pattern ([Salesforce Ben](https://www.salesforceben.com/salesforce-chatter/)). HubSpot activity index pages aggregate activity across records ([HubSpot filter activity index](https://knowledge.hubspot.com/records/view-the-history-of-an-activity-on-a-record)).

**Fit with Smart-CRM.** Almost free **if #5 exists** — it's a different query over the same `RecordEvent` table (`@@index([orgId, createdAt])` is already there for this) unioned with `Comment`. New page `src/app/(app)/feed/page.tsx` (RSC, cursor-paginated) + a sidebar nav entry (`NAV` array in `app-sidebar.tsx`). Could also become the new default landing tile on `/dashboard`.

**Effort:** **S–M** (mostly query + page; the data already exists via #5). Deps: **#5 (hard)**.
**Tier:** **Free / core** (a strong differentiator-by-polish for small teams; cheap once #5 lands).

---

### 9. Mobile / Responsive Experience (nav + record + comment on the go)

**Description.** Make Smart-CRM usable on a phone. Concretely: (a) a mobile top `AppHeader` with a hamburger that opens the existing nav in a slide-over (Radix `Sheet`/`Dialog`), since the sidebar is `hidden md:flex`; (b) responsive list→card layouts (the `<Table>` views overflow on mobile today); (c) the bell + composer must be reachable on mobile. This is "responsive web," explicitly the in-scope deliverable — not a native app.

**Competitor evidence.** Mobile is a core CRM expectation: HubSpot's mobile app supports "full CRM features: contacts, deals, tasks, calls, email, pipeline updates" with real-time notifications; Pipedrive's is "designed specifically for salespeople" with offline + push ([HubSpot vs Pipedrive 2026](https://www.engagebay.com/blog/hubspot-vs-pipedrive/), [Pipedrive push notifications](https://support.pipedrive.com/en/article/push-notifications-in-the-mobile-app)). Smart-CRM doesn't need native parity, but a sales rep updating a deal or reading an @mention from their phone is the canonical mobile CRM job-to-be-done.

**Fit with Smart-CRM.**
- **No schema.** Pure UI in `src/components/**` + `layout.tsx`.
- Introduce `AppHeader` (shared with #3's bell) + a `MobileNav` sheet reusing the same `NAV` array from `app-sidebar.tsx` (extract `NAV` to a shared module so desktop + mobile stay in sync). shadcn/Radix already in the stack — add a `sheet` primitive (sibling to existing `dialog.tsx`).
- Make `Table`-based lists collapse to stacked cards under `md` (Tailwind responsive classes), and ensure the record aside (comments/feed) stacks below the form on small screens (the `lg:grid-cols-3` in `deals/[id]/page.tsx` already degrades; verify contacts/companies do too).

**Effort:** **M** (touches layout + every list/detail page for responsive polish; the nav drawer itself is S).
**Tier:** **Free / core** (basic baseline). A future **installable PWA + web-push** for mobile notifications could be a paid/Pro add-on.

---

### 10. Notification Preferences & Email/Digest Delivery

**Description.** A preferences screen (per user, per org) controlling *which* events notify you and *how*: in-app only, instant email, or a daily/weekly **digest** ("Your CRM this week: 4 mentions, 2 deals won"). Sensible defaults out of the box.

**Competitor evidence.** Pipedrive: "Manage notifications" settings to choose which notifications and how (panel vs email) ([Pipedrive notifications](https://support.pipedrive.com/en/article/notifications)). HubSpot has granular per-event user notification settings ([HubSpot user notifications](https://knowledge.hubspot.com/user-management/how-to-set-up-user-notifications-in-hubspot)). UX best practice: "let users decide how they want to receive notifications … real-time, daily summaries, or weekly digests"; offer a "summary mode" ([equal.design](https://www.equal.design/blog/in-app-notifications-best-practices-for-saas), [Smashing Magazine](https://www.smashingmagazine.com/2025/07/design-guidelines-better-notifications-ux/)).

**Fit with Smart-CRM.**
- **Schema:** `NotificationPreference { userId, orgId, type, inApp Boolean, email Boolean }` (or a single JSON blob on Membership for simplicity). `notify()` consults this before fanning out / before queuing email.
- **Email** introduces a new dependency (Resend/SMTP/Nodemailer) — currently no mailer exists in the repo. Digests need a scheduled job (Vercel Cron). This is the heaviest piece and should follow the in-app system, not lead it.
- **UI:** a section under `/settings` (existing page) with a matrix of toggles; reuse `members-section.tsx` form patterns.

**Effort:** **L** (email infra + cron + matrix UI). Deps: #3/#4 (the notification types must exist first).
**Tier:** In-app toggles **Free**; **email + digests = paid tier** (operational cost + a common upsell line).

---

### 11. Multi-Owner / Collaborators & Ownership Handoff

**Description.** Two related upgrades to ownership: (a) **assign/reassign owner** with a proper UI + an event in the timeline + a notification to the new owner ("a deal was assigned to you"); (b) add **secondary collaborators** beyond the single `ownerId` (e.g. an SE or manager attached to a deal) so the team around a record is explicit. Includes `ADMIN`-driven **bulk reassignment** (e.g. when a rep leaves).

**Competitor evidence.** HubSpot notifies users "when a deal is assigned to you" ([HubSpot follow a record](https://knowledge.hubspot.com/crm-setup/follow-a-record)). Assignment/ownership transfer and reassignment are core to both HubSpot and Salesforce, including "Rotate record to owner" and reassignment workflows ([RevBlack lead routing](https://www.revblack.com/guides/automatic-lead-routing-hubspot-salesforce), [nc-squared Salesforce assignment](https://nc-squared.com/blog/article/understanding-lead-assignment-in-salesforce-core-concepts-best-practices)). When a rep leaves, bulk reassigning their records is a standard admin job.

**Fit with Smart-CRM.**
- **Schema:** `ownerId` already exists on `Deal`/`Activity`. Add `ownerId` to `Contact`/`Company` (currently missing — a real gap). For collaborators, a `RecordCollaborator { orgId, entityType, entityId, userId, role? }` join (mirrors `Follow`). Reassignment is an update to `ownerId` + a `RecordEvent` (#5) + a `notify()` (#4).
- **Server actions:** `assignOwner(entityType, entityId, userId)` and an `ADMIN`-gated `bulkReassign(fromUserId, toUserId)`; the latter also makes `removeMember` safer (today `removeMember` in `org.ts` just deletes the membership while `onDelete: SetNull` orphans owned deals — handoff should be offered first).
- **UI:** an owner-picker dropdown in record headers + a collaborators list in the aside; an admin "reassign records" flow in Settings.

**Effort:** **M.** Deps: #5 (events) + #4 (notifications) for the full experience; the `Contact/Company.ownerId` add is independent and small.
**Tier:** Single-owner reassignment **Free**; **collaborators + bulk reassignment = paid tier**.

---

### 12. Automated Assignment Routing (round-robin / rules) — *stretch*

**Description.** Auto-assign new records (or new inbound leads) to reps via rules: round-robin across a team, or simple conditions ("deals > $50k → Maya"). Removes the manual "who takes this?" step.

**Competitor evidence.** Both HubSpot and Salesforce offer round-robin/rotation, gated behind their automation tiers — HubSpot's "Rotate record to owner" requires Workflows (Pro/Enterprise); Salesforce uses assignment rules/Flows ([Default round-robin guide](https://www.default.com/post/round-robin-lead-assignment-salesforce), [HubSpot community](https://community.hubspot.com/t5/Tips-Tricks-Best-Practices/Round-Robin-Assignment-of-Leads/m-p/895007)). The fact that competitors **paywall** this confirms both its value and that it's a fair premium line.

**Fit with Smart-CRM.**
- **Schema:** `AssignmentRule { orgId, scope, conditions Json, strategy(ROUND_ROBIN|FIRST_MATCH), targetUserIds String[], cursor Int }`.
- Evaluated inside create actions (`deals.ts`/`contacts.ts`) when no owner is set; round-robin advances a stored cursor. Pairs naturally with #11's assignment notification.
- **UI:** rules builder in Settings (`ADMIN`+).

**Effort:** **L** (rules engine + builder UI; correctness around concurrency/cursor). Deps: #11.
**Tier:** **Paid / Pro** (matches competitor packaging).

---

## Dependency & sequencing summary

```
Foundation:   #1 Comments ─┬─> #2 @Mentions ─┐
                           │                  ├─> #4 Notification wiring ─> #6 Follow
#3 Notif Center + AppHeader ┘                  │
#5 RecordEvent feed ───────────────────────────┴─> #8 Org feed
                                               #11 Ownership/handoff
Independent:  #7 Saved/Shared Views    #9 Mobile/responsive (shares AppHeader with #3)
Later/heavy:  #10 Email digests        #12 Auto-routing
```

`AppHeader` is a shared unlock for both **#3 (bell)** and **#9 (mobile nav)** — building it once early de-risks both. The `CommentEntity`/`entityType` + `entityId` convention is reused across Comment, RecordEvent, Follow, SavedView, and collaborators — define it once.

---

## Tiering at a glance

| Idea | Effort | Tier |
|---|---|---|
| 1. Record comments | M | Free / core |
| 2. @Mentions | M | Free / core |
| 3. Notification center | M | Free / core |
| 4. Mention/comment notifications | S | Free / core |
| 5. Per-record activity/change feed | M | Free (history retention → paid) |
| 6. Follow / subscribe | S–M | Free / core |
| 7. Saved & shared views | M | Private free / shared paid |
| 8. Org-wide activity feed | S–M | Free / core |
| 9. Mobile / responsive | M | Free / core (PWA push → paid) |
| 10. Notification prefs + email digest | L | In-app free / email paid |
| 11. Multi-owner & ownership handoff | M | Free (collaborators/bulk → paid) |
| 12. Automated assignment routing | L | Paid / Pro |

---

## Top 3 picks

1. **Record Comments + @Mentions (#1 + #2).** The single highest-impact, table-stakes gap. Every competitor treats comment-with-mention on a record as baseline collaboration, and Smart-CRM has *none*. It's the foundation the whole feature area builds on, and it slots cleanly into the existing record-detail aside and server-action/`ActionResult` patterns. **Effort M.**

2. **In-App Notification Center + notification wiring (#3 + #4).** A mention or assignment is worthless if no one sees it. The bell-in-header + dropdown + `/notifications` page is the universal CRM pattern (Pipedrive/Zoho bell), and building the shared `AppHeader` here also unblocks mobile nav. Poll-on-focus keeps it inside the current stack — no websocket infra. **Effort M.**

3. **Saved & Shared Views (#7).** Highest UX leverage per unit of effort and *independent* of the comments stack, so it can ship in parallel. The list pages already serialize filters into `searchParams` — persisting that as a named, shareable view is a small step that materially changes how teams (especially managers) use the product, and Team-visibility views are a clean paid upsell. **Effort M.**
