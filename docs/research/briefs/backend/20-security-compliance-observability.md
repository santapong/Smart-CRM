# Smart-CRM — Security, Compliance & Observability Program (Design Brief)

**Author:** Backend/Platform Engineering
**Date:** 2026-06-20
**Scope:** Cross-cutting hardening to make Smart-CRM sellable to businesses — abuse protection, observability, encryption/secrets, security headers/CSP, GDPR data-subject tooling, SOC 2 readiness, and uptime/DR.

---

## Context: current posture (from the codebase)

What exists today (verified by reading the source):

- **AuthN/Z:** NextAuth v5 (beta.25) with a Credentials provider (`bcryptjs` hashing) and JWT sessions (`src/lib/auth.ts`, `src/lib/auth.config.ts`). Tenant scoping via `requireOrg()` (`src/lib/tenant.ts`); role gates via `hasRole`/`requireRole` ranks `MEMBER < ADMIN < OWNER` (`src/lib/rbac.ts`).
- **Input validation:** Zod in server actions; env validation via t3-env at `src/env.ts` (note: lives at `src/env.ts`, not `src/lib/env.ts`).
- **Edge middleware** (`src/middleware.ts`) runs NextAuth `authorized` on nearly all routes; matcher excludes only `_next/static`, `_next/image`, `favicon.ico`. `/`, `/login`, `/signup`, `/api/auth/*` are public.

Material gaps relevant to this brief:

- **No rate limiting** anywhere — `authorize()` in `src/lib/auth.ts` does an unthrottled `bcrypt.compare` per request (CPU-bound brute-force + DoS amplification vector). No public lead-capture endpoint exists yet, but it is on the roadmap and will be unauthenticated.
- **Sensitive fields stored in plaintext:** `Account.refresh_token` / `access_token` / `id_token` are `@db.Text` plaintext (`prisma/schema.prisma` lines 34-39). Contact `email`/`phone` and Company/Contact/Deal `notes` are plaintext PII.
- **No audit log model** — there is no record of who changed what, which is a SOC 2 CC blocker and an incident-forensics gap.
- **No security headers / CSP** — `next.config.mjs` sets none; `images.remotePatterns` allows `https://**` (any host).
- **No error monitoring, no APM/tracing, no structured logging.** No request/audit correlation IDs.
- **No documented backup/DR (RPO/RTO), no data-retention jobs, no GDPR export/erasure tooling, no DPA artifact, no dependency/secret scanning in CI.**

**Good news already in place** (reduces effort): JWT session strategy + Next.js Server Actions give a strong CSRF baseline (Origin/Host check, POST-only, SameSite cookies — see capability 5); Postgres providers (Neon/Supabase/Vercel Postgres) give TLS-in-transit and AES-256 at-rest by default plus managed PITR (capability 9).

> **Reference legend** — each capability cites sources inline. URLs collected under "## References".

---

## 1. Rate limiting & abuse protection

**(1) What it enables.** Stops credential-stuffing/brute-force on login, scraping/enumeration of the API, and spam/DoS on the future public lead-capture endpoint. Caps cost (each failed login is a `bcrypt.compare`) and protects availability — directly supports SOC 2 Availability.

**(2) Design.**
- Use **`@upstash/ratelimit` + Upstash Redis (REST/HTTP)** — connectionless, works in Vercel Edge and Node runtimes; per-identifier `ratelimit.limit(identifier)` with an in-function **ephemeral cache** so hot lambdas skip Redis round-trips. [Upstash README]
- Three named limiters with different policies (the README shows naming via `prefix` and `slidingWindow`):
  - **Auth** (`/api/auth/*`, `signIn`, signup action): `slidingWindow(5, "15 m")` keyed by **IP + email**, plus a slower secondary IP-only limit (e.g. 20/h) to blunt distributed attempts. Brute-force endpoints get the strictest limit. [Upstash blog: nextjs-ratelimiting]
  - **Public lead-capture** (future unauthenticated form ingest): `slidingWindow(10, "1 m")` per IP, plus a per-org daily cap, plus a honeypot/Turnstile check. Public write endpoints are the highest-abuse surface.
  - **Authenticated API / mutations:** `slidingWindow(100, "1 m")` keyed by `userId` (and a per-`orgId` ceiling) to contain a compromised account.
- **Where applied:** a thin `withRateLimit(limiter, identifier)` helper called (a) at the top of sensitive **server actions** (login/signup, bulk import, invite), (b) in **route handlers** under `src/app/api/`, and (c) optionally in `src/middleware.ts` for coarse edge-level IP limits on `/api/*`. Choose **sliding window** over fixed window to avoid burst-at-boundary, and over token bucket unless you need burst allowance. [Upstash README]
- Return `429` with `Retry-After` and `X-RateLimit-*` headers; log every block as a security event (capability 4).

**(3) Reference evidence.** Upstash ratelimit-js README (algorithms `fixedWindow`/`slidingWindow`/`tokenBucket`, per-identifier `limit()`, ephemeral cache, multi-region). Upstash blog "Rate Limiting Next.js API Routes" (auth = 5/15m sliding window pattern). OWASP recommends rate limiting + account lockout as the primary brute-force / credential-stuffing control (OWASP Authentication Cheat Sheet; ASVS V2/V11).

**(4) Effort: S–M.** Deps: Upstash account + `UPSTASH_REDIS_REST_URL`/`_TOKEN` env vars (add to `src/env.ts`). Auth + one API limiter is S; full coverage incl. lead-capture + per-org ceilings is M.

**(5) Tier: Foundation.** Highest-leverage abuse control; unblocks safe public endpoints.

---

## 2. Error monitoring & distributed tracing

**(1) What it enables.** Real-time visibility into production exceptions (currently invisible) with stack traces, release/environment tagging, breadcrumbs, and request → DB span traces to find slow Server Actions/Prisma queries. Cuts MTTR and provides the "system monitoring" evidence SOC 2 expects.

**(2) Design.**
- **Sentry for Next.js** (`@sentry/nextjs`) — installs via `npx @sentry/wizard@latest -i nextjs`. Needed pieces: `instrumentation.ts` at project/`src` root importing server + edge configs and exporting **`onRequestError`** (captures Server Component / route errors), client config via `instrumentation-client.ts`, and **`app/global-error.tsx`** to catch render errors; wrap `next.config.mjs` with `withSentryConfig` for source maps + tunneling. [Sentry Next.js manual setup; automatic instrumentation]
- **Tracing:** set `tracesSampleRate` modestly (e.g. `0.1`–`0.2`) to control cost; Sentry auto-instruments API routes, data fetchers, and (with the Prisma integration) DB spans. Tag every event with `release`, `environment`, `orgId`, and the **request correlation ID** from capability 4 so errors, logs, and traces line up. [Sentry tracing]
- **Compliance/PII:** keep **`sendDefaultPii: false`** and add `beforeSend`/`beforeSendTransaction` scrubbing for emails, phones, tokens, and `notes` so a CRM record never lands in Sentry. Configure server-side **data scrubbing** and EU **data residency** project if selling to EU customers. (Mirrors OWASP "don't log PII/secrets" — capability 4.)
- Sentry is **OpenTelemetry-compatible** under the hood, so if you later standardize on OTel collectors you can keep the same spans; alternatively emit OTel from `instrumentation.ts` to a vendor (SigNoz/Grafana) — see capability 4 for the logging half.

**(3) Reference evidence.** Sentry Next.js manual-setup + automatic-instrumentation docs (instrumentation.ts, onRequestError, global-error.tsx, tracesSampleRate; "Next.js 14 or 15 recommended"). Sentry data-scrubbing/`sendDefaultPii` guidance.

**(4) Effort: S.** Wizard does most wiring. Deps: Sentry DSN env var; PII scrubbing rules require a short review of the data model.

**(5) Tier: Foundation.** You cannot operate a paid SaaS blind to production errors.

---

## 3. Structured logging with request & audit correlation

**(1) What it enables.** Replaces ad-hoc `console.log` with queryable JSON logs carrying a **correlation/request ID** (and Sentry trace/span IDs), enabling cross-system root-cause analysis and an **audit trail** of security-relevant actions — a hard SOC 2 requirement.

**(2) Design.**
- **App logs:** `pino` for fast JSON logs. Generate a per-request `requestId` (UUID) in `src/middleware.ts`, propagate via an `x-request-id` header / AsyncLocalStorage, and attach it to every log line. Use **`@opentelemetry/instrumentation-pino`** + `pino-opentelemetry-transport` so each line carries `traceId`/`spanId` and ships off the event loop via a worker thread. [DEV/SigNoz OTel-Next.js-Pino guides]
- **What to log / not log (OWASP):** log authn success/failure, authz failures, input-validation failures, session/JWT failures, rate-limit blocks, and **sensitive operations** (user admin, role changes, data exports). **Never** log passwords, session/access tokens, DB connection strings, payment data, or full PII — mask/hash/encrypt first. Use synchronized timestamps and stable interaction IDs. [OWASP Logging Cheat Sheet]
- **Audit log (tamper-evident, app-level):** add a Prisma `AuditLog` model — `id, orgId, actorUserId, action, entityType, entityId, before/after (redacted JSON), ip, requestId, createdAt` — written from a wrapper around mutating server actions. This is **distinct** from operational logs: it is the business record of "who changed what" for tenant admins and auditors. Store append-only (no update/delete grants for the app role); ship to centralized storage for integrity. [OWASP Logging; SOC 2 audit-log control]
- **Where applied:** middleware (requestId), the server-action wrapper (audit), the rate-limit helper (security events), and a `logger` singleton used everywhere instead of `console`.

**(3) Reference evidence.** OWASP Logging Cheat Sheet (events to log / not log, correlation IDs, synchronized time, log integrity & access monitoring). SigNoz / DEV.to guides on Next.js + OpenTelemetry + Pino trace-correlated structured logging. SOC 2 checklists require "system activity, change logs, and security alerts."

**(4) Effort: M.** Deps: `pino` + OTel instrumentation; `AuditLog` migration + a mutation wrapper threaded through existing server actions (the bulk of the work). Pairs with capability 2 for trace IDs.

**(5) Tier: Core.** Foundational for SOC 2 and forensics; slightly more invasive than 1–2, so sequence right after them.

---

## 4. Encryption of sensitive fields & tokens at rest

**(1) What it enables.** Protects OAuth/refresh tokens and the most sensitive PII even if a DB dump, backup, or read-replica leaks — and lets you answer "is customer data encrypted?" in security questionnaires with specifics beyond "the disk is encrypted."

**(2) Design.**
- **Baseline (free, already true):** managed Postgres (Neon/Supabase/Vercel) encrypts data **at rest (AES-256)** and **in transit (TLS)** by default — keep `sslmode=require` in `DATABASE_URL`. This covers disk theft but **not** a running-server compromise or a leaked logical dump. [Tiger Data / Crunchy Postgres security guides]
- **App-level (envelope) encryption for the crown jewels:** encrypt `Account.refresh_token`/`access_token`/`id_token` and any future API keys/secrets with **AES-256-GCM** in a small `crypto.ts` (Node `crypto`), keyed by a `DATA_ENCRYPTION_KEY` held in secrets (capability 6), authenticated (GCM) and stored as `{iv, ciphertext, tag}`. App-level keeps plaintext off the DB box entirely and is portable across providers; the tradeoff is you lose SQL-side search on those columns (acceptable for tokens). [OWASP Secrets Mgmt recommends AES-256-GCM / ChaCha20-Poly1305; Crunchy/Sahaj pgcrypto guide]
- **pgcrypto alternative** for columns you must query/operate on inside SQL — but note decryption happens **server-side**, so the key transits to the DB and plaintext exists in DB memory; prefer app-level for tokens, reserve pgcrypto for niche cases. [Sahaj pgcrypto guide; Postgres encryption comparison]
- **PII (`Contact.email/phone`, `*.notes`):** do **not** rush to encrypt searchable PII (breaks `@@index([orgId, email])` and filtering). Instead rely on the managed at-rest encryption + strict access control (capability 8) + field-level redaction in logs/Sentry. Revisit deterministic/blind-index encryption only if a customer contract demands it.
- **Key rotation:** version keys (`keyId` byte prefix) so you can rotate without a big-bang re-encrypt. [OWASP Secrets Mgmt: rotate regularly]

**(3) Reference evidence.** OWASP Secrets Management Cheat Sheet (AES-256-GCM, never co-locate keys with data, rotation). Crunchy Data "Data Encryption in Postgres" and Sahaj pgcrypto guide (field-level vs filesystem; server-side decryption caveat). Tiger Data Postgres security best practices.

**(4) Effort: M.** Token encryption is S–M (one helper + NextAuth adapter read/write hooks + migration). Broad PII encryption is L and discouraged for now.

**(5) Tier: Core.** Token encryption is high-value/low-cost; do it. Searchable-PII encryption is a Strategic Bet, contract-driven.

---

## 5. Security headers, CSP & CSRF posture

**(1) What it enables.** Defense-in-depth against XSS, clickjacking, MIME-sniffing, and protocol downgrade; confirms Server Actions are CSRF-safe. Directly answers common questionnaire/pentest findings.

**(2) Design.**
- **Static security headers** in `next.config.mjs` `headers()` (or middleware): `Strict-Transport-Security` (HSTS, long max-age + preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`), `Referrer-Policy: strict-origin-when-cross-origin`, and a tight `Permissions-Policy`. [TurboStarter Next.js security guide; Next.js CSP docs]
- **CSP with per-request nonce** generated in `src/middleware.ts` (`crypto.randomUUID()` → base64), set on an `x-nonce` request header and in the `Content-Security-Policy` `script-src 'nonce-…' 'strict-dynamic'`. Caveat: nonce CSP forces **dynamic rendering** and the matcher should skip prefetches/static assets. Start in **`Content-Security-Policy-Report-Only`** with a report endpoint, then enforce. [Next.js CSP docs; Next.js middleware CSP guides]
- **Tighten `images.remotePatterns`** — replace `hostname: "**"` with the specific avatar/upload hosts to avoid the open image-proxy/SSRF-adjacent surface.
- **CSRF posture (mostly already good):** Next.js **Server Actions are POST-only and validate `Origin` vs `Host`/`X-Forwarded-Host`** and ride SameSite cookies — a strong built-in CSRF defense, so no token plumbing needed for actions. **However**, **route handlers under `src/app/api/*` have NO built-in CSRF protection**; any state-changing API route consumed by the browser must add an explicit Origin check or CSRF token, and webhook routes must use signature verification + the rate limiter. [Next.js "Thinking about security in Server Components/Actions"; Next.js data-security guide]

**(3) Reference evidence.** Next.js docs — CSP-with-nonce via middleware (dynamic-render & prefetch caveats) and "How to Think About Security in Next.js" (Server Actions Origin/Host check, POST-only; API routes unprotected). TurboStarter "Complete Next.js Security Guide" (header set). OWASP Secure Headers / CSRF cheat sheets.

**(4) Effort: S–M.** Static headers + `remotePatterns` fix = S. Nonce-based CSP rollout (report-only → enforce, fixing inline-script violations) = M.

**(5) Tier: Foundation** for the static headers + CSRF audit; **Core** for full nonce CSP enforcement.

---

## 6. Secret management & rotation

**(1) What it enables.** Reduces blast radius of leaked credentials, enables rotation, and provides an auditable "where do secrets live / who can read them" answer for SOC 2 access control.

**(2) Design.**
- **Today:** secrets are plain env vars validated by t3-env (`src/env.ts`). Acceptable as a baseline on Vercel (encrypted env vars, per-environment scoping), but ad hoc.
- **Near term:** keep Vercel encrypted env vars as the source of truth but (a) **document an inventory + owner + rotation schedule** for each (`AUTH_SECRET`, `DATABASE_URL`, `RESEND_API_KEY`, new `UPSTASH_*`, `DATA_ENCRYPTION_KEY`, Sentry DSN), (b) enforce **least-privilege** access to the Vercel/DB dashboards, (c) **never** print secrets in logs (capability 3). [OWASP Secrets Mgmt: centralize, least privilege, rotate]
- **Strategic:** adopt a dedicated store (**Vercel + an external vault, AWS Secrets Manager, or HashiCorp Vault/Doppler**) for dynamic/rotatable secrets and automated rotation (scheduled job/serverless) — OWASP recommends centralizing in a managed secret store with automated rotation and keys stored separately from the data they protect (ties to capability 4's `DATA_ENCRYPTION_KEY`). [OWASP Secrets Mgmt]

**(3) Reference evidence.** OWASP Secrets Management Cheat Sheet (no hardcoded secrets; centralized vault — AWS Secrets Manager / Azure Key Vault / GCP Secret Manager / HashiCorp Vault; automated rotation; least privilege; never co-locate keys with secrets; pre-commit/CI leak detection → capability 7).

**(4) Effort: S** for inventory + rotation policy + least-privilege; **M** for a managed vault rollout.

**(5) Tier: Foundation** for the policy/inventory; **Strategic Bet** for a full vault.

---

## 7. Dependency, secret & code scanning in CI

**(1) What it enables.** Catches vulnerable npm packages, leaked secrets, and supply-chain attacks before they ship — supports SOC 2 vulnerability-management and change-management controls.

**(2) Design.**
- **Dependabot** (native to GitHub): version + security updates for `npm` and `github-actions` ecosystems via `.github/dependabot.yml`; auto-PRs with changelog/CVE context. [Snyk npm best practices; SCA tools comparison]
- **GitHub secret scanning + push protection** on the repo to block committed credentials; pair with a **pre-commit secret scanner** (e.g. detect-secrets/gitleaks) so leaks are caught before push. [OWASP Secrets Mgmt; Snyk]
- **SCA in CI:** add `pnpm audit` (or **Snyk**, richer remediation) as a required GitHub Actions check; store any `SNYK_TOKEN` as an Actions secret. Optionally **Socket** for install-time supply-chain/malicious-package detection (relevant after 2025 npm worm-style attacks). [Snyk "npm security best practices / Shai-Hulud"; SCA comparison]
- **Where applied:** `.github/` workflows + `dependabot.yml`; gate merges on the scan jobs (also satisfies change-management evidence).

**(3) Reference evidence.** Snyk "NPM Security Best Practices" (Dependabot/Snyk reviewable PRs, secret scanning, supply-chain). Rafter SCA comparison (Snyk vs Dependabot vs Renovate). OWASP Secrets Mgmt (automated leaked-secret detection at IDE/pre-commit/CI).

**(4) Effort: S.** Mostly config. Deps: GitHub repo settings + optional Snyk token.

**(5) Tier: Foundation.** Cheap, automated, continuously valuable.

---

## 8. GDPR data-subject tooling (export, erasure, retention) + DPA

**(1) What it enables.** Lets you honor **Right to Access/Portability (Art. 15/20)** and **Right to Erasure (Art. 17)** within the **one-month** statutory window, define lawful retention, and provide a **DPA** — table-stakes to sell to EU (and many enterprise) customers.

**(2) Design.**
- **Export / portability:** an authenticated, role-gated action that assembles a tenant's data (contacts, companies, deals, activities, tags, members) into **machine-readable JSON + CSV** (open formats) and delivers a download/email link; generatable within the one-month deadline. Log it as a sensitive operation (capability 3). [Legiscope Art. 20; Drata GDPR-for-SaaS]
- **Erasure:** a deletion workflow that removes/anonymizes personal data across **DB rows, logs, Sentry, and third parties (Resend, Upstash)** — note erasure and portability are **separate** requests. Use Prisma cascade deletes (already modeled via `onDelete: Cascade`) for hard delete, plus **anonymization** where records must persist for integrity (e.g. null out PII on a closed `Deal` rather than delete the deal). Define how **backups** are handled (PITR windows age out personal data on a documented schedule rather than surgically editing backups). [GDPR Art. 17; Drata; ECOMPLY SaaS checklist]
- **Retention jobs:** define retention periods per data type and run a scheduled job (Vercel Cron / queue) to purge/anonymize expired data (e.g. soft-deleted records, stale activity, raw lead-capture payloads) per the storage-limitation principle. [GDPR storage limitation; ECOMPLY]
- **DPA + records:** publish a **Data Processing Addendum**, maintain a **Record of Processing Activities (RoPA)** and a sub-processor list (Vercel, Neon/Supabase, Resend, Upstash, Sentry), and surface a consent/lawful-basis note on the public lead-capture form. [Drata GDPR-for-SaaS; ECOMPLY SaaS checklist]

**(3) Reference evidence.** GDPR Art. 17 (erasure) & Art. 20 (portability — structured, commonly-used, machine-readable; open format e.g. CSV); Art. 12(3) one-month response window. Drata "GDPR for SaaS"; ECOMPLY GDPR SaaS checklist; Legiscope data-portability guide (export across logs/backups/third parties; retention automation).

**(4) Effort: M–L.** Export is M; full erasure across third parties + retention jobs + DPA/RoPA is L (legal + engineering). Schema already cascades, which helps.

**(5) Tier: Core** (export + erasure are deal-blockers for EU/enterprise); retention automation + DPA/RoPA can phase in as **Core→Strategic**.

---

## 9. Backups, disaster recovery & uptime/health checks

**(1) What it enables.** Defined, *tested* recovery with explicit **RPO/RTO**, plus liveness/readiness signals — the backbone of SOC 2 **Availability** and a standard procurement question.

**(2) Design.**
- **Backups/PITR:** rely on the managed Postgres provider's **point-in-time recovery** and document the resulting objectives. Neon offers PITR up to **30 days** retention with LSN granularity and near-instant restore. Supabase provides daily backups (`pg_dumpall`) plus **PITR (WAL-G) with seconds-granularity** as a Pro+ add-on; enable it. Set a target **RPO ≤ minutes** (PITR) and **RTO ≤ 1 hour** for the DB tier and write it down. [Neon PITR blog/docs; Supabase backups docs]
- **DR runbook + tests:** document restore steps, who executes them, and **schedule a periodic restore drill** (restore to a branch/scratch project and verify) — SOC 2 expects you to *test* backups, not just have them. Keep an **off-provider logical dump** (e.g. nightly `pg_dump` to object storage) to mitigate provider-account compromise. [SOC 2 readiness checklists]
- **Uptime / health checks:** add `GET /api/health` (liveness) and `GET /api/health/ready` (checks DB + Redis reachability) — make them **public but unauthenticated and cheap**, excluded from the auth middleware and rate-limited. Wire an external uptime monitor (Better Stack/UptimeRobot/Vercel) with alerting; expose a public status page. Pair with Sentry cron-monitor checks for the retention/backup jobs.

**(3) Reference evidence.** Neon "Announcing Point-in-Time Restore" + Backups docs (30-day PITR, LSN granularity, seconds to restore). Supabase Database Backups docs (daily `pg_dumpall`, PITR via WAL-G, seconds granularity, add-on). SOC 2 readiness checklists (test backups, BCDR, secure backup proves Availability).

**(4) Effort: S–M.** Health endpoints + enabling/ documenting PITR + uptime monitor = S–M. Off-provider dump job + scheduled DR drills = M.

**(5) Tier: Foundation** (health checks + enable/document PITR with RPO/RTO); **Core** for off-provider backups + tested DR drills.

---

## 10. SOC 2 readiness program (umbrella control mapping)

**(1) What it enables.** A coherent, auditor-legible story tying the above capabilities to Trust Services Criteria, so a Type I (point-in-time) then Type II (3–12 month operating effectiveness) audit is achievable — the credential most enterprise buyers gate on.

**(2) Design — map controls to capabilities + close the people/process gaps:**
- **Access control (CC6):** enforce **MFA** on GitHub/Vercel/DB dashboards and in-app (add an MFA option to NextAuth); least-privilege via existing `rbac.ts`; **quarterly access reviews** of org memberships and admin accounts; documented joiner/mover/leaver. [SOC 2 checklists]
- **Audit logging / monitoring (CC7):** the `AuditLog` (capability 3) + Sentry alerts (capability 2) + log retention.
- **Change management (CC8):** require PR review + status checks (capability 7) + the build/deploy pipeline; retain PR/deploy artifacts as evidence (aligns to existing GitHub flow).
- **Risk assessment / vendor mgmt (CC3/CC9):** maintain the sub-processor list + annual risk review.
- **Availability (A1):** backups/PITR + tested DR + uptime monitoring (capability 9).
- **Confidentiality / encryption (CC6.7):** TLS + at-rest + token encryption (capability 4); secrets policy (capability 6).
- **Incident response (CC7.3–7.5):** a written IR plan + on-call + Sentry/uptime alert routing; tabletop test.
- **Tooling:** a compliance-automation platform (**Drata/Vanta/Secureframe**) to collect evidence continuously — the checklists stress automated, sustainable evidence for Type II.
- **Phasing (per startup playbooks):** Foundation (weeks 1–4) → technical gaps: MFA, encryption, logging, access controls (weeks ~8–16) → operational procedures: access reviews, change mgmt, IR (then a 3–12 month observation window for Type II).

**(3) Reference evidence.** Drata / TrustCloud / Splunk / Cycore SOC 2 readiness checklists (control categories: logical access, change mgmt, system ops, risk; embed into PR/deploy flow; Type II = controls operating 3–12 months with automated evidence; phased timeline; test backups/access/IR).

**(4) Effort: L.** Cross-functional, multi-month; most engineering pieces are the capabilities above — the incremental cost is process, policy, MFA, and an evidence platform.

**(5) Tier: Strategic Bet.** Big investment, unlocks upmarket revenue; sequence after Foundation/Core items make the controls real.

---

## Top 3 picks

1. **Rate limiting & abuse protection (capability 1)** — Foundation, S–M. Closes the most acute live risk (unthrottled `bcrypt` login + future public lead-capture) and protects availability/cost. Do first.
2. **Error monitoring + tracing with Sentry (capability 2)** — Foundation, S. You are currently blind to production failures; a wizard-grade install yields immediate MTTR and SOC 2 monitoring evidence (with PII scrubbing on).
3. **Structured logging + audit log with correlation IDs (capability 3)** — Core, M. The `AuditLog` + request/trace correlation is the keystone that unblocks SOC 2 (CC7), GDPR export/erasure evidence, and forensics — and it amplifies the value of #1 and #2.

*Sequencing note:* do **secret/dependency scanning (7)** and **static security headers + `remotePatterns` fix (5, partial)** in parallel — both are S/config-only Foundation wins. Token encryption (4) and health checks/PITR docs (9) follow; GDPR tooling (8) and the full SOC 2 program (10) are the larger Core/Strategic tracks.

---

## References

- Upstash `ratelimit-js` README — algorithms (`fixedWindow`/`slidingWindow`/`tokenBucket`), per-identifier `limit()`, ephemeral in-memory cache, multi-region: https://github.com/upstash/ratelimit-js (raw: https://raw.githubusercontent.com/upstash/ratelimit-js/main/README.md)
- Upstash blog — "Rate Limiting Next.js API Routes using Upstash Redis" (auth = 5/15m sliding window): https://upstash.com/blog/nextjs-ratelimiting ; Edge rate limiting: https://upstash.com/blog/edge-rate-limiting
- Sentry — Next.js manual setup (instrumentation.ts, onRequestError, global-error.tsx, withSentryConfig): https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
- Sentry — automatic instrumentation / tracing (`tracesSampleRate`): https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/instrumentation/automatic-instrumentation/ and https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing/
- OWASP Logging Cheat Sheet — what to log / not log, correlation IDs, time sync, log integrity: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html (raw: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Logging_Cheat_Sheet.md)
- OWASP Secrets Management Cheat Sheet — no hardcoding, centralized vaults, AES-256-GCM, rotation, least privilege, leak detection: https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html (raw: https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Secrets_Management_Cheat_Sheet.md)
- Next.js — Content Security Policy with nonce via middleware (dynamic render / prefetch caveats): https://nextjs.org/docs/app/guides/content-security-policy
- Next.js — "How to Think About Security in Server Components and Server Actions" (Origin/Host check, POST-only; API routes unprotected): https://nextjs.org/blog/security-nextjs-server-components-actions ; Data Security guide: https://nextjs.org/docs/app/guides/data-security
- TurboStarter — "Complete Next.js Security Guide" (security header set): https://www.turbostarter.dev/blog/complete-nextjs-security-guide-2025-authentication-api-protection-and-best-practices
- Postgres encryption — Crunchy Data "Data Encryption in Postgres": https://www.crunchydata.com/blog/data-encryption-in-postgres-a-guidebook ; Sahaj pgcrypto guide (server-side decryption caveat): https://www.sahaj.ai/a-practical-guide-to-implementing-sensitive-data-encryption-using-postgres-pgcrypto/ ; Tiger Data Postgres security best practices: https://www.tigerdata.com/learn/postgres-security-best-practices
- OpenTelemetry + Next.js + Pino structured logging / trace correlation — SigNoz: https://signoz.io/blog/opentelemetry-nextjs-logging/ ; DEV.to (Pino 9 + OTel): https://dev.to/1xapi/how-to-add-structured-logging-to-nodejs-apis-with-pino-9-opentelemetry-2026-guide-3jd2
- Dependency/secret scanning — Snyk "NPM Security Best Practices (Shai-Hulud)": https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/ ; SCA tools comparison (Snyk vs Dependabot vs Renovate): https://rafter.so/blog/sca-tools-comparison
- GDPR — Art. 17 erasure: https://gdpr-info.eu/art-17-gdpr/ ; Art. 20 portability (Legiscope): https://www.legiscope.com/blog/data-portability-right.html ; Drata "GDPR for SaaS": https://drata.com/learn/gdpr/for-saas-compliance ; ECOMPLY GDPR SaaS checklist: https://www.ecomply.io/blog-en/gdpr-saas-checklist
- Backups/DR — Neon PITR: https://neon.com/blog/announcing-point-in-time-restore and https://neon.com/docs/manage/backups ; Supabase backups (daily + PITR/WAL-G): https://supabase.com/docs/guides/platform/backups
- SOC 2 readiness checklists — Drata: https://drata.com/learn/soc-2/checklist ; TrustCloud: https://www.trustcloud.ai/soc-2/soc2-audit-checklist-a-comprehensive-guide/ ; Splunk: https://www.splunk.com/en_us/blog/learn/soc-2-compliance-checklist.html ; Cycore (2025): https://www.cycoresecure.com/blogs/soc-2-audit-readiness-checklist-2025
