# Smart CRM

A lightweight, multi-tenant CRM built with Next.js 15, TypeScript, Postgres + Prisma,
NextAuth, and Tailwind/shadcn. Includes Contacts, Companies, Deals (Kanban),
Activities, and a Reporting Dashboard.

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

## Deploy

Designed for Vercel + a managed Postgres (Vercel Postgres, Neon, Supabase, etc.).
See [`docs/DEPLOY.md`](./docs/DEPLOY.md) for a step-by-step guide — short version:

- `vercel.json` pins the install / build commands and region.
- `postinstall` runs `prisma generate`, so the Vercel build needs no extra hook.
- Set `DATABASE_URL` to a **pooled** Postgres URL (PgBouncer transaction mode)
  and `DIRECT_URL` to the direct URL for migrations. The middleware is
  edge-safe (`src/lib/auth.config.ts`) so it deploys to the edge runtime
  without bcrypt/Prisma getting bundled.
- Required env vars: `DATABASE_URL`, `AUTH_SECRET`, `AUTH_TRUST_HOST=true`.
  `AUTH_URL` is optional on Vercel (auto-detected); set it on Production
  only if you want to lock callbacks to a custom domain.
