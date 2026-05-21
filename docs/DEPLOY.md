# Deploying Smart-CRM to Vercel

This guide walks through a fresh deploy of `main` to Vercel with a managed
Postgres. The repo is already configured for it: `package.json` runs
`prisma generate` on `postinstall` and in `build`, the middleware is
edge-safe, and `vercel.json` pins the framework, install command, and
region.

## Prerequisites

- A GitHub account with this repo connected to Vercel.
- A Postgres database that supports **transaction-mode connection
  pooling**. Recommended providers:
  - [Vercel Postgres](https://vercel.com/storage/postgres) — easiest, the
    pooled and direct URLs are provisioned for you.
  - [Neon](https://neon.tech) — separate pooled / direct hostnames.
  - [Supabase](https://supabase.com) — use the "Connection Pooling" URL.
- Node 20+ and pnpm 9+ locally for the one-time schema push.

## 1. Provision the database

Create a Postgres instance with your provider of choice and grab two URLs:

| Variable       | Use                                  | Example shape                                                    |
| -------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `DATABASE_URL` | **Pooled** URL used at runtime       | `postgres://…@…-pooler.neon.tech/db?sslmode=require&pgbouncer=true&connection_limit=1` |
| `DIRECT_URL`   | Direct URL used by Prisma migrations | `postgres://…@…neon.tech/db?sslmode=require`                     |

Why two URLs? Vercel serverless invocations each open a new connection.
Without a pooler you'll exhaust the database's connection limit under
load. Migrations, on the other hand, need a direct connection because
they issue prepared statements that PgBouncer in transaction mode
doesn't support.

`DIRECT_URL` is optional locally — Prisma falls back to `DATABASE_URL`
when it's unset.

## 2. Push the schema (one time)

From your laptop, with `DATABASE_URL` pointed at the new database:

```bash
export DATABASE_URL="postgres://…direct…"   # use the DIRECT url here
pnpm install
pnpm db:push
pnpm db:seed                                 # optional demo data
```

(`db:push` is fine for v1 — there is no `prisma/migrations/` directory
yet. If you graduate to migration-based deploys, swap in
`prisma migrate deploy`.)

## 3. Import the project into Vercel

1. New Project → **Import Git Repository** → pick this repo.
2. Framework Preset: **Next.js** (auto-detected).
3. Build & Output Settings: leave defaults — `vercel.json` handles them.
4. Environment Variables — add **all** of the following to both
   `Production` and `Preview`:

   | Key                  | Value                                                            |
   | -------------------- | ---------------------------------------------------------------- |
   | `DATABASE_URL`       | Pooled connection URL from step 1                                |
   | `DIRECT_URL`         | Direct connection URL from step 1                                |
   | `AUTH_SECRET`        | `openssl rand -base64 32`                                        |
   | `AUTH_URL`           | Your production URL, e.g. `https://crm.example.com` (Production only — leave blank on Preview so NextAuth uses the per-deployment URL) |
   | `AUTH_TRUST_HOST`    | `true` (required for Preview deploys behind Vercel's proxy)      |
   | `EMAIL_FROM`         | optional, e.g. `no-reply@example.com`                            |
   | `RESEND_API_KEY`     | optional, for magic-link email sign-in                           |

5. Click **Deploy**. The first build runs `prisma generate && next build`
   and pushes the route table — no DB writes happen here, so it's safe
   to redeploy as often as you like without affecting the schema.

## 4. Verify

- Visit the deployed URL → you should land on `/login`.
- Sign up a new user → an `Organization` is created with that user as
  `OWNER`.
- (Optional) If you seeded demo data, sign in with `owner@demo.com` /
  `password123` to see the Acme Demo Co. tenant.

## 5. Future schema changes

For now, schema evolves via `pnpm db:push` against the direct URL:

```bash
DATABASE_URL=$DIRECT_URL pnpm db:push
```

When the model stabilises and you want repeatable migrations across
environments, run `pnpm prisma migrate dev --name init` once locally to
seed `prisma/migrations/`, commit those files, and switch the Vercel
build to `prisma migrate deploy && next build`.

## Troubleshooting

| Symptom                                                            | Likely cause                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `prisma generate` runs but the app can't reach the DB at runtime   | `DATABASE_URL` not set in **Production** scope, or set to the direct URL instead of pooled  |
| `Sorry, you have been redirected too many times` on `/login`       | `AUTH_TRUST_HOST` is unset on a Preview deploy                                              |
| `PrismaClientInitializationError: Can't reach database server`     | Pooled URL host is wrong, or the pooler is paused (Neon "compute" auto-suspend)             |
| Build fails with `Environment variable not found: DATABASE_URL`    | `DATABASE_URL` not set on Vercel for the current target (Production / Preview / Development)|
| Sign-in works locally but cookies don't persist on Vercel          | `AUTH_URL` doesn't match the actual host the browser sees — clear it on Preview, set it to the canonical domain on Production |
