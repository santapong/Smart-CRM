# Smart CRM

A lightweight, multi-tenant CRM built with Next.js 15, TypeScript, Postgres + Prisma,
NextAuth, and Tailwind/shadcn. Includes Accounts (with hierarchy + tiering),
Contacts, Deals (Kanban), Activities, Tickets with per-tier SLA tracking,
custom fields, and a Reporting Dashboard.

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

## Enterprise accounts

Accounts (the Prisma model stays `Company`, the UI says "Account") carry a
tier (SMB / MID_MARKET / ENTERPRISE / STRATEGIC), an optional parent so you
can model subsidiaries, and ARR. Each account has an `AccountAssignment`
team: one user can hold multiple roles (Owner, AE, SE, CSM, Exec Sponsor) on
the same account.

Contacts have an `isPrimary` flag (one primary per account, enforced
server-side) and a decision role (Champion / Economic Buyer / User /
Influencer / Blocker).

### Tickets + SLAs

`SlaPolicy(orgId, tier)` defines a first-response and resolution budget per
tier. Tickets are scoped to an account and optionally a contact, and breach
state is computed on-read in `src/lib/sla.ts` (WITHIN / AT_RISK / BREACHED /
MET). No cron required for v1.

Manage SLA budgets from **Settings → SLA policies** (ADMIN-gated).

### Custom fields

`CustomFieldDefinition(orgId, entity, key, type)` lets each org add fields
to Companies, Contacts, or Deals without per-tenant schema migrations. The
value table uses typed columns (`valueText / valueNumber / valueDate /
valueBoolean`) and supports TEXT, URL, NUMBER, DATE, BOOLEAN, and SELECT.

Manage definitions from **Settings → Custom fields** (ADMIN-gated). Values
appear inline on the relevant entity detail page.

## Deploy

Designed for Vercel + a managed Postgres (Neon, Supabase, RDS, etc.). Set
`DATABASE_URL`, `AUTH_SECRET`, and `AUTH_URL` in the project environment.
