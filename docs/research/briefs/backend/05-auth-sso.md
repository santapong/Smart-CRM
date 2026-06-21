# Smart-CRM — Identity & Authentication Roadmap

**Author:** Backend/Platform (Auth & Identity)
**Date:** 2026-06-20
**Scope:** RESEARCH / DESIGN ONLY — no repo changes proposed as code, only schema sketches and config plans.

---

## Current state (read from repo)

- **NextAuth v5 (beta)** with `@auth/prisma-adapter`, **JWT session strategy**, **Credentials provider only** (bcrypt via `bcryptjs`).
  - `src/lib/auth.ts` — Node-side config: `PrismaAdapter(db)`, `Credentials({ authorize })`, `jwt`/`session` callbacks that inject `id`, `activeOrgId`, `role` from the `Membership` table.
  - `src/lib/auth.config.ts` — **edge-safe** config (no bcrypt/Prisma), `session.strategy: "jwt"`, `pages.signIn: "/login"`, `authorized` callback for route protection. This is exactly the recommended v5 split-config pattern.
- **Schema (`prisma/schema.prisma`):**
  - `User` already has `emailVerified DateTime?`, `image`, `passwordHash String?` (nullable — OAuth-ready).
  - `Account` model present and complete (refresh/access tokens, id_token) — **OAuth/OIDC ready, currently unused**.
  - `VerificationToken` model present — **email-verification/magic-link ready, currently unused**.
  - `Session` model present but **unused** (JWT strategy bypasses it).
  - Tenancy: `Organization` / `Membership` / `Role(OWNER|ADMIN|MEMBER)` — this is the anchor for SSO domain-binding and SCIM group→role mapping.
- **Env:** `RESEND_API_KEY` and `EMAIL_FROM` exist but are **unused** → email verification, magic links, password reset are NOT implemented. No MFA, no SSO, no social login.

### Cross-cutting NextAuth v5 / Vercel notes (apply to every item below)
- **Env naming:** v5 prefers `AUTH_*` over `NEXTAUTH_*`. `AUTH_SECRET` is the only strictly-required var; it both encrypts the JWT (JWE, A256GCM) **and hashes the email verification tokens**. Provider creds auto-infer when named by convention, e.g. `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. [authjs migrating-to-v5; authjs deployment]
- **Existing `RESEND_API_KEY`/`EMAIL_FROM`** should be re-pointed to the convention `AUTH_RESEND_KEY` (or passed explicitly to the provider) when wiring Resend.
- **Edge constraint (Vercel middleware = Edge runtime):** Prisma + bcrypt cannot run in middleware. The repo already isolates them: keep all DB/crypto in `auth.ts`, keep `auth.config.ts` import-clean. Any new DB-touching auth logic (MFA check, session revocation lookup) must live in route handlers / server actions / the `jwt` callback that runs in the Node lambda, NOT in `middleware.ts`. [authjs migrating-to-v5]
- **`trustHost`:** set `AUTH_TRUST_HOST=true` (or `trustHost: true`) when behind Vercel's proxy; `NEXTAUTH_URL` is not needed on Vercel.
- **JWT strategy trade-off (drives the session-hardening item):** JWTs can't be revoked before expiry without a server-side check; database sessions are revocable but query-per-request and Edge-incompatible. [next-auth FAQ; GitHub discussion #1571]

---

## Capabilities

### 1. Google & Microsoft (Entra ID) social login — *Foundation*

**(1) What it enables.** One-click sign-in/sign-up with Google and Microsoft work/personal accounts. Removes password friction, lifts conversion, and is the on-ramp for "Sign in with your work Google/Microsoft account" before full enterprise SSO. The `Account` table already exists to store the linked OAuth identities.

**(2) Design.**
- Add providers in `src/lib/auth.ts` (Node side; can also be referenced in `auth.config.ts` since these are edge-safe — but keep the adapter in `auth.ts`):
  ```ts
  import Google from "next-auth/providers/google";
  import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
  // providers: [ Credentials({...}), Google, MicrosoftEntraID({ issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER }) ]
  ```
- Env: `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`/`_ISSUER` (issuer defaults to `.../common/v2.0` for multi-tenant). [authjs entra-id provider]
- **Schema:** none required — `Account` is already adapter-shaped. Consider adding `User.image` population from profile (already present).
- **Account linking decision:** by default v5 does not auto-link an OAuth identity to an existing email/password user (anti-takeover). Decide policy: either require sign-in-then-link, or enable `allowDangerousEmailAccountLinking` only for providers with verified emails (Google/Entra verify email) — document the risk.
- **Tenant onboarding:** on first OAuth sign-in there is no `Membership`; the existing `jwt` callback finds none and leaves `activeOrgId` null. Add a post-sign-in onboarding step (create org or accept invite) — a `signIn`/`events.createUser` hook can seed this.

**(3) Reference evidence.** Auth.js v5 provider docs and Prisma adapter confirm `Account`-table shape and JWT-with-adapter support. [authjs Prisma adapter; authjs entra-id]; v5 env auto-inference (`AUTH_<PROVIDER>_ID/SECRET`) and split-config. [authjs migrating-to-v5]

**(4) Effort: S.** Deps: OAuth app registration in Google Cloud + Entra; account-linking policy decision.

**(5) Tier: Foundation.**

---

### 2. Email verification (Resend) — *Foundation*

**(1) What it enables.** Verify ownership of an email on signup before granting full access; sets `User.emailVerified`. Prerequisite for trustworthy magic links, password reset, and anti-abuse. Activates the dormant `RESEND_API_KEY`/`EMAIL_FROM`.

**(2) Design.**
- Two viable paths:
  - **(a) Native Auth.js Resend provider** (also doubles as magic-link, item 3). `import Resend from "next-auth/providers/resend"; Resend({ apiKey: AUTH_RESEND_KEY, from: EMAIL_FROM })`. **Requires the DB adapter + `VerificationToken` table — already present.** The docs are explicit: *"It is not possible to enable email sign in without using a database"* and you must *"setup one of the database adapters for storing the Email verification token."* [authjs resend provider]
  - **(b) Custom flow for the credentials-signup path:** since users register with email+password (not via the email provider), issue our own token. Reuse `VerificationToken` (or a dedicated table), generate a token, email via the Resend SDK directly, and on click set `User.emailVerified = now()`. Gate login (or feature access) on `emailVerified`.
- **Recommended:** do (b) for the existing credentials signup, and adopt the provider (a) as part of item 3. `AUTH_SECRET` hashes the stored verification tokens. [authjs deployment]
- **Schema:** none new strictly required (`VerificationToken` exists). Optional: dedicated `EmailToken { id, userId, type(VERIFY|RESET), tokenHash, expiresAt }` if you want typed tokens + audit, instead of overloading `VerificationToken`.
- **Vercel:** add a cron (`vercel.json` cron → route handler) to purge expired tokens.

**(3) Reference evidence.** Resend provider doc: DB + adapter + `VerificationToken` mandatory; `AUTH_RESEND_KEY`/`from`. [authjs resend provider]. `AUTH_SECRET` hashes verification tokens. [authjs deployment]

**(4) Effort: S–M.** Deps: verified sending domain in Resend; email templates.

**(5) Tier: Foundation.**

---

### 3. Magic-link / passwordless sign-in (Resend) — *Core*

**(1) What it enables.** Passwordless login via an emailed one-time link — lower friction, no password to phish/reset. Shares all plumbing with item 2.

**(2) Design.**
- Enable the **Resend email provider** (config from item 2a). Flow: user enters email → Auth.js writes a `VerificationToken` → Resend sends the link → click verifies token → session issued; a `User` row is created on first verification.
- Customize `generateVerificationToken()` (e.g., `crypto.randomUUID()`) and `sendVerificationRequest`/`normalizeIdentifier` for branded emails and case-folded emails. [authjs resend provider]
- Coexistence with Credentials + JWT: both providers can run together; the JWT callback already keys off `token.sub` so org/role hydration is unchanged.
- **Abuse controls:** rate-limit per email/IP, short token TTL (e.g., 10 min), single-use.

**(3) Reference evidence.** Resend provider sends "magic links" with verification-token URLs; supports `generateVerificationToken`/`normalizeIdentifier`; requires DB adapter. [authjs resend provider; authjs email/providers].

**(4) Effort: S** (once item 2's Resend domain + adapter usage is in place).

**(5) Tier: Core.**

---

### 4. Password reset & forgot-password flow — *Foundation*

**(1) What it enables.** Self-service recovery for credentials users — table-stakes for any password-based product; currently entirely missing.

**(2) Design.**
- Not provided by NextAuth (it owns sign-in, not password management) → build as **server actions + route handlers**:
  1. `requestReset(email)` → if user exists, create a single-use token (reuse `VerificationToken` with a `reset:` identifier prefix, or the dedicated `EmailToken` from item 2), email link via Resend. Always return success (no user enumeration).
  2. `resetPassword(token, newPassword)` → validate token + expiry, `bcrypt.hash` (matching `authorize`'s `bcrypt.compare`), update `User.passwordHash`, delete token, optionally **revoke existing sessions** (ties to item 7).
- **Schema:** none new if reusing `VerificationToken`; dedicated `EmailToken` recommended for clarity + audit.
- Mirror the existing `credentialsSchema` Zod validation (min length etc.).

**(3) Reference evidence.** NextAuth manages auth flows but not password storage/reset → custom flow is standard; reuse the `VerificationToken` model already in schema (adapter-managed) for tokens. [next-auth FAQ; authjs Prisma adapter].

**(4) Effort: S–M.** Deps: items 2 (Resend domain) shared; session-revocation hook (item 7) optional but recommended.

**(5) Tier: Foundation.**

---

### 5. TOTP multi-factor authentication (2FA) — *Core*

**(1) What it enables.** App-based second factor (Google Authenticator/Authy/1Password) for credential and email logins; backup codes for recovery. Major security uplift and an enterprise checklist item.

**(2) Design.**
- Library: **`otplib`** (generate secret, build `otpauth://` URI, verify 6-digit code) + a QR generator (`qrcode`) for enrollment. [otplib/logto/supertokens guides]
- **Schema sketch:**
  ```prisma
  model TwoFactor {
    id            String   @id @default(cuid())
    userId        String   @unique
    secret        String              // encrypt at rest (app-level), not plaintext
    enabled       Boolean  @default(false)
    backupCodes   String[]            // hashed (bcrypt/argon)
    createdAt     DateTime @default(now())
    user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  }
  ```
  (add `twoFactor TwoFactor?` to `User`).
- **Flow with JWT sessions (the hard part):** NextAuth has no native MFA step-up, so model a two-phase login. Options:
  - In `authorize`, if `twoFactor.enabled`, throw/return a sentinel so the client routes to an OTP screen; complete sign-in only after a server action verifies the code (e.g., a short-lived "mfa-pending" token, or a dedicated credentials sub-provider that accepts `email+password+otp`).
  - Stamp the JWT with `amr: ["mfa"]` / `mfaVerifiedAt` in the `jwt` callback so middleware/pages can require it.
- Enforce that MFA users cannot bypass via magic link unless that path also challenges.

**(3) Reference evidence.** `otplib` generates/verifies TOTP and QR enrollment; NextAuth custom 2FA "requires manual implementation of secret storage, backup codes, and step-up auth." [supertokens add-mfa-to-nextjs; logto 2FA Node; next-auth-2fa example].

**(4) Effort: M.** Deps: secret encryption strategy; two-phase login UX; backup-code hashing.

**(5) Tier: Core.**

---

### 6. Enterprise SAML / OIDC SSO (WorkOS or BoxyHQ Jackson) — *Strategic Bet*

**(1) What it enables.** Lets business customers log in via their IdP (Okta, Entra, Google Workspace, OneLogin, etc.) with per-tenant SAML/OIDC connections — a hard requirement to sell to mid-market/enterprise and move upmarket.

**(2) Design — two paths benchmarked:**

- **Path A — BoxyHQ Jackson (open-source, self-host or embed).** Jackson exposes the **SAML/OIDC login as a normal OAuth 2.0 flow**, hiding SAML/XML complexity. Deploy as a **separate Docker service** or **embed via `@boxyhq/saml-jackson` npm**. NextAuth has a **first-class provider**:
  ```ts
  import BoxyHQ from "next-auth/providers/boxyhq-saml";
  BoxyHQ({
    authorization: { params: { scope: "" } },
    clientId: AUTH_BOXYHQ_SAML_ID,        // typically "dummy"; real selection via tenant/product
    clientSecret: AUTH_BOXYHQ_SAML_SECRET,
    issuer: AUTH_BOXYHQ_SAML_ISSUER,       // URL of your Jackson instance
  })
  // client: signIn("boxyhq-saml", {}, { tenant, product })
  ```
  Per-tenant connections are keyed by `tenant`+`product`; the common pattern is to derive `tenant` from the email **domain**. [authjs boxyhq-saml provider; boxyhq jackson]. Self-host means **no per-connection fee** but you operate the service + its DB.

- **Path B — WorkOS (managed).** Clean SSO + Directory Sync APIs; fastest time-to-first-enterprise-deal. Pricing: **$125 per SSO connection / month**, Directory Sync (SCIM) **also $125 per active connection / month** (volume discounts >15 connections); AuthKit free to **1M MAU**. [workos pricing/guide; scalekit/supertokens summaries]. Integrates via WorkOS-hosted callback; can sit alongside NextAuth as a custom OIDC/OAuth provider or via AuthKit.

- **Tenant binding (both paths):** map an **email domain → `Organization`** (new `OrgDomain { orgId, domain, verified }` table), and on SSO callback resolve/auto-provision the `Membership` with a default `Role`. Just-in-time provisioning creates the `User` + `Membership` on first SSO login. Reuse the existing `jwt`/`session` callbacks to project `activeOrgId`/`role`.
  ```prisma
  model OrgDomain {
    id        String  @id @default(cuid())
    orgId     String
    domain    String  @unique
    verified  Boolean @default(false)
    org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  }
  model SsoConnection {            // metadata for admin UI; secrets live in Jackson/WorkOS
    id        String  @id @default(cuid())
    orgId     String
    type      String              // "saml" | "oidc"
    tenant    String              // Jackson tenant key (e.g., domain)
    product   String
    createdAt DateTime @default(now())
    org       Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  }
  ```

**Recommendation:** start with **Jackson embedded/self-hosted** (no per-connection cost, native NextAuth provider, OSS) for the first enterprise pilots; keep WorkOS as the escape hatch if operational burden or IdP-edge-case coverage becomes painful.

**(3) Reference evidence.** Jackson = "Enterprise SAML SSO as an OAuth 2.0 flow," deploy separate or embed via `@boxyhq/saml-jackson`, supports SCIM 2.0; native Auth.js provider with `tenant`/`product` + domain-routing. [authjs boxyhq-saml; npm @boxyhq/saml-jackson; boxyhq jackson]. WorkOS per-connection pricing and free AuthKit tier. [workos pricing; scalekit/supertokens WorkOS alternatives].

**(4) Effort: L.** Deps: Jackson service + its Postgres (or WorkOS account), org-domain verification, JIT provisioning, admin UI for connections.

**(5) Tier: Strategic Bet.**

---

### 7. Session hardening — rotation, device list, revocation — *Core*

**(1) What it enables.** "Sign out everywhere," visible **active sessions/devices** with revoke, forced logout on password reset / role change, and bounded blast radius for stolen tokens. Current pure-JWT sessions are **non-revocable before expiry**.

**(2) Design.**
- **Core tension:** JWT (current) is Edge-friendly + cheap but unrevocable; DB sessions are revocable but query-per-request and Edge-incompatible. [next-auth FAQ; discussion #1571]. Recommended **hybrid** that keeps JWT + Edge middleware:
  - Add a server-side **session/token registry** and validate a token's `jti`/`sid` against it in the Node-side `jwt`/`session` callback (not in Edge middleware). Revoking = deleting/flagging the row → next callback rejects.
  ```prisma
  model AuthSession {
    id           String   @id @default(cuid())
    userId       String
    sid          String   @unique        // also embedded in JWT
    userAgent    String?
    ip           String?
    createdAt    DateTime @default(now())
    lastSeenAt   DateTime @default(now())
    revokedAt    DateTime?
    user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  }
  ```
  - **Device list UI** = query `AuthSession` for the user; **revoke** sets `revokedAt`.
  - Add a `User.tokenVersion Int @default(0)`; bump it on password reset / "log out everywhere" / role downgrade and compare in the `jwt` callback → instant global invalidation without per-request DB reads if you embed the version in the token and only re-check on refresh.
- Keep short JWT `maxAge` + rotation (NextAuth rotates the `expires`/keep-alive automatically) to bound exposure. [next-auth FAQ/options].
- Cookie hardening: confirm `httpOnly`, `secure`, `sameSite` (defaults are good); JWE encryption is on by default (A256GCM). [next-auth FAQ].
- Alternatively, flip the whole strategy to **database sessions** (the unused `Session` model already exists) for true revocation — but this loses Edge middleware checks and adds a DB read per request; only worth it if revocation guarantees outweigh latency.

**(3) Reference evidence.** JWTs cannot be invalidated before expiry without a server-side blocklist; DB sessions are revocable but require per-request queries and are Edge-incompatible; NextAuth auto-rotates session expiry. [next-auth FAQ; GitHub discussion #1571; next-auth options].

**(4) Effort: M–L.** Deps: schema migration, `jwt` callback changes, device-list UI, decide hybrid vs full DB sessions.

**(5) Tier: Core.**

---

### 8. SCIM directory provisioning & deprovisioning — *Strategic Bet*

**(1) What it enables.** Enterprises auto-provision/deprovision users and sync groups from their IdP (Okta/Entra) into Smart-CRM via **SCIM 2.0** — so offboarding in the IdP instantly revokes CRM access, and group membership maps to `Role`. Closes enterprise security-review requirements alongside SSO (item 6).

**(2) Design.**
- **Reuse the item-6 vendor:** both **BoxyHQ Jackson** (Directory Sync, SCIM 2.0, self-host/embed) and **WorkOS** (Directory Sync, $125/active connection/mo) provide SCIM endpoints + webhooks; we consume their events rather than implementing the SCIM server ourselves. [boxyhq jackson; workos scim-vs-sso; workos pricing].
- **Event handling:** subscribe to user.created/updated/deactivated and group events → upsert `User`, create/update/delete `Membership` for the mapped `Organization`, map IdP **group → `Role`** (OWNER/ADMIN/MEMBER). Deactivation → revoke `Membership` and **revoke sessions** (item 7).
- **Schema:** add to support mapping/idempotency:
  ```prisma
  model ScimMapping {
    id            String  @id @default(cuid())
    orgId         String
    externalId    String              // IdP user/group id
    userId        String?
    groupName     String?
    role          Role?
    @@unique([orgId, externalId])
  }
  ```
- SCIM is independent of SSO (a user can be provisioned before first login), so build it after SSO but design the org-domain/tenant binding once and share it.

**(3) Reference evidence.** "SCIM vs SSO" — complementary; SCIM automates provisioning/deprovisioning. [workos scim-vs-sso]. Jackson Directory Sync + SCIM 2.0 (activate/deactivate, groups, real-time). [boxyhq jackson; npm @boxyhq/saml-jackson]. WorkOS Directory Sync standalone @ $125/connection. [workos pricing; scalekit summary].

**(4) Effort: L.** Deps: item 6 (same vendor + org-domain binding), webhook endpoint, group→role policy, idempotent sync.

**(5) Tier: Strategic Bet.**

---

## Top 3 picks

1. **Email verification + password reset via Resend (items 2 & 4)** — *Foundation, S–M.* Closes the most glaring gap (password-only with no recovery/verification), activates the already-present `RESEND_API_KEY`/`EMAIL_FROM` and `VerificationToken` model, and unblocks magic links. Lowest effort, highest baseline-trust payoff.
2. **Google & Microsoft social login (item 1)** — *Foundation, S.* `Account` table is already adapter-ready; near-zero schema work, big conversion + UX win, and the stepping stone toward enterprise identity.
3. **Enterprise SAML/OIDC SSO via BoxyHQ Jackson (item 6)** — *Strategic Bet, L.* The revenue-unlocking capability for moving upmarket; native Auth.js provider + OSS/self-host avoids WorkOS per-connection fees, and its org-domain/tenant binding is the shared foundation that SCIM (item 8) later reuses.

---

## Sources
- Auth.js — Migrating to v5 (env `AUTH_*`, `AUTH_SECRET`, provider auto-inference, edge split-config, `trustHost`): https://authjs.dev/getting-started/migrating-to-v5
- Auth.js — Resend provider (DB adapter + VerificationToken required, `AUTH_RESEND_KEY`/`from`, `generateVerificationToken`/`normalizeIdentifier`): https://authjs.dev/getting-started/providers/resend
- Auth.js — Email providers overview: https://authjs.dev/getting-started/authentication/email
- Auth.js — Microsoft Entra ID provider: https://authjs.dev/getting-started/providers/microsoft-entra-id
- Auth.js — Prisma adapter (Account/Session/VerificationToken shapes; JWT-with-adapter): https://authjs.dev/getting-started/adapters/prisma
- Auth.js — BoxyHQ SAML provider (OAuth-flow SSO, `tenant`/`product`, domain routing): https://authjs.dev/getting-started/providers/boxyhq-saml
- Auth.js — Deployment (`AUTH_SECRET` hashes verification tokens; Vercel; `AUTH_TRUST_HOST`): https://next-auth.js.org/deployment
- NextAuth.js — FAQ & Options (JWT vs DB sessions, revocation/blocklist, session rotation, cookie/JWE defaults): https://next-auth.js.org/faq , https://next-auth.js.org/configuration/options
- NextAuth.js — Discussion #1571 (JWT + session token + database trade-offs): https://github.com/nextauthjs/next-auth/discussions/1571
- BoxyHQ Jackson — `@boxyhq/saml-jackson` (SAML/OIDC SSO as OAuth flow, self-host/embed, SCIM 2.0 Directory Sync): https://www.npmjs.com/package/@boxyhq/saml-jackson
- WorkOS — SCIM vs SSO guide: https://workos.com/guide/scim-vs-sso
- WorkOS pricing summary ($125/SSO connection, $125/SCIM connection, AuthKit free to 1M MAU): https://www.scalekit.com/blog/workos-alternatives , https://supertokens.com/blog/workos-alternatives
- TOTP MFA with otplib / NextAuth custom 2FA (secret storage, backup codes, step-up): https://supertokens.com/blog/add-mfa-to-nextjs , https://blog.logto.io/support-authenticator-app-verification-for-your-nodejs-app , https://github.com/bharathvaj-ganesan/next-auth-2fa-example
