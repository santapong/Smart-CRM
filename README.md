# Smart CRM

A lightweight, multi-tenant CRM built with Next.js 15, TypeScript, Postgres + Prisma,
NextAuth, and Tailwind/shadcn. Includes Contacts, Companies, Deals (Kanban),
Activities, a Reporting Dashboard, and outbound messaging over email, Telegram,
and LINE.

## Quickstart

```bash
pnpm install
cp .env.example .env
docker compose up -d              # starts Postgres on :5432
pnpm db:push                       # apply schema
pnpm db:seed                       # demo data: owner@demo.com / password123
pnpm dev                           # http://localhost:3000
```

## Stack

- **Next.js 15** (App Router, React Server Components, server actions)
- **TypeScript** strict
- **Prisma** + **Postgres**
- **NextAuth v5** (credentials + Prisma adapter)
- **Tailwind CSS** + shadcn-style primitives
- **@dnd-kit** for the Deals Kanban
- **recharts** for the dashboard
- **Vitest** + **Playwright** for tests
- **GitHub Actions** for CI

## Project layout

```
src/
  app/
    (auth)/login, signup                # auth pages
    (app)/dashboard, contacts, companies, deals, activities, settings
    api/auth/[...nextauth]              # NextAuth handlers
  components/                           # UI primitives + shared components
  lib/                                  # auth, db, tenant, rbac, env, utils
  server/actions/                       # typed server actions per entity
prisma/                                 # schema + seed
tests/                                  # unit (Vitest) + e2e (Playwright)
.claude/agents/                         # role-based subagent definitions
.github/workflows/ci.yml                # CI pipeline
```

## Subagents

The `.claude/agents/` directory contains role definitions used by Claude Code
when working on this repo: project-manager, backend-engineer,
frontend-engineer, qa-engineer, devops, and code-reviewer.

## Scripts

| Script              | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `pnpm dev`          | Run the Next.js dev server.                        |
| `pnpm build`        | `prisma generate` + production build.              |
| `pnpm start`        | Run the production server.                         |
| `pnpm lint`         | ESLint.                                            |
| `pnpm typecheck`    | `tsc --noEmit`.                                    |
| `pnpm test`         | Vitest unit tests.                                 |
| `pnpm test:e2e`     | Playwright smoke (requires built app + Postgres).  |
| `pnpm db:push`      | Push schema to dev DB.                             |
| `pnpm db:seed`      | Seed demo data.                                    |
| `pnpm db:studio`    | Prisma Studio.                                     |

## Tenancy

Every business table carries an `orgId`. All server actions go through
`requireOrg()` in `src/lib/tenant.ts`, which derives the active org from the
NextAuth session. There is no path from an authenticated user to data in a
different org.

## Auth

Credentials provider only (email + password). To enable email magic links, add
a Resend API key to `.env` and add an EmailProvider to `src/lib/auth.ts`.

## Messaging (email, Telegram, LINE)

Outbound messages route through a single `MessageChannel` interface defined in
`src/server/messaging/`. Each channel is a thin driver over a third-party SDK:

- **Email** — Resend. Set `RESEND_API_KEY` and `EMAIL_FROM`.
- **Telegram** — `telegraf` against a single shared bot. Set `TELEGRAM_BOT_TOKEN`
  and (recommended) `TELEGRAM_WEBHOOK_SECRET`. Register the webhook via
  Telegram's `setWebhook` and point it at `/api/webhooks/telegram`, passing the
  same secret as `secret_token`.
- **LINE** — `@line/bot-sdk` against a single shared Messaging API channel. Set
  `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET`. Point the LINE webhook
  at `/api/webhooks/line` — inbound requests are HMAC-verified against the
  channel secret.
- **Resend delivery events** (optional) — point Resend's webhook at
  `/api/webhooks/resend` to flip the `MessageLog` status from `SENT` to
  `DELIVERED` / `FAILED` based on the event type.

Contacts carry a `telegramChatId`, `lineUserId`, `preferredChannel`, and a
per-channel opt-in flag. The Send Message panel on the contact detail page
greys out channels the contact is unreachable on. Every send writes a
`MessageLog` row scoped to the org, so the thread history is visible per
contact.

`MessageTemplate` rows let you save reusable bodies per `(org, channel, key)`
with `{{firstName}}`-style placeholders.

## Deploy

Designed for Vercel + a managed Postgres (Neon, Supabase, RDS, etc.). Set
`DATABASE_URL`, `AUTH_SECRET`, and `AUTH_URL` in the project environment.
