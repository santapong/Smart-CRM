# Smart-CRM — File Storage & Attachments (Backend Design Brief)

**Author:** Backend/platform engineering
**Date:** 2026-06-20
**Scope:** Object storage choice; direct/presigned client uploads (around the Vercel 4.5MB body limit); polymorphic `Attachment` model (orgId-scoped); signed-URL download + permission checks; virus scanning; size/type limits + per-plan quotas; image transforms/thumbnails; path to document features (templates, e-sign).

---

## Current-state findings (from repo)

- **Stack:** Next.js 15 (App Router), Prisma 5.22 + Postgres, NextAuth v5 beta, deployed on Vercel serverless. `package.json` confirms no storage SDK is present (`@vercel/blob`, `@aws-sdk/*` absent).
- **Multi-tenancy:** every domain model carries `orgId` and a `@relation(... onDelete: Cascade)` to `Organization`. Tenant isolation is enforced in server actions via `requireOrg()` → `{ userId, orgId, role }` (`src/lib/tenant.ts`) and `findFirst({ where: { id, orgId } })` (see `src/server/actions/contacts.ts`).
- **RBAC:** `src/lib/rbac.ts` ranks `MEMBER(1) < ADMIN(2) < OWNER(3)`; `requireRole(actual, required)` throws `ForbiddenError`. Roles live on `Membership.role`.
- **Server-action convention:** `"use server"`, Zod `safeParse`, return `ActionResult<T>` (`ok()` / `fail()` from `src/lib/action-result.ts`), then `revalidatePath()`.
- **Env:** validated with `@t3-oss/env-nextjs` in `src/env.ts` — new storage secrets must be added there (server block + `runtimeEnv`).
- **Attachable records today:** `Company`, `Contact`, `Deal`, `Activity`. The brief also mentions **emails** — no `Email`/`Message` model exists yet, so the design treats it as a future `entityType` value, not a current FK.
- **CRITICAL constraints:**
  - Vercel serverless functions cap request **and** response bodies at **4.5 MB** → `413 FUNCTION_PAYLOAD_TOO_LARGE`. Server-action file uploads through the function will fail for anything but tiny files. ([Vercel limits](https://vercel.com/docs/functions/limitations), [Vercel KB: bypass body limit](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions))
  - **No billing/plan/quota model exists** — quotas (capability 6) require a new `Plan`/limits concept or a hard-coded default tier first.
  - Postgres uses a **pooled** connection (PgBouncer transaction mode per `.env.example`); webhook/scan callbacks that write Prisma are fine, but keep them short.

### Design principle: thin provider adapter
All capabilities below assume a small `src/lib/storage/` adapter interface (`createUploadToken`, `getSignedDownloadUrl`, `deleteObject`, `headObject`) so the **provider choice is swappable**. The `Attachment` model stores a `provider` + `key`, never a provider-locked URL. This lets us start on Vercel Blob (fastest) and migrate to R2/S3 later without schema churn.

---

## Capability 1 — Object storage provider choice (foundation decision)

**What it enables:** the actual durable store for every file; sets the cost curve (storage + egress) and the upload/security primitives available.

**Design — provider matrix (Vercel-hosted app):**

| Provider | Storage $/GB-mo | Egress | Free tier | Native client/presigned upload | Vercel fit |
|---|---|---|---|---|---|
| **Vercel Blob** | $0.023 | **$0.05/GB** transfer | 1 GB + 10 GB transfer (Hobby) | **Yes** — `handleUpload` token exchange, `@vercel/blob/client put()` | Tightest: same dashboard/env, zero infra |
| **AWS S3** | $0.023 | **$0.09/GB** (expensive) | 12-mo trial only | Yes — `createPresignedPost` / `getSignedUrl` (SDK v3) | Good; most features (Lambda scan, Textract, etc.) |
| **Cloudflare R2** | **$0.015** | **$0 (zero egress)** | 10 GB + 1M Class-A + 10M Class-B /mo | Yes — S3-compatible, AWS SDK `createPresignedPost`/`getSignedUrl` | Good; cheapest at scale, S3-API drop-in |
| **Supabase Storage** | ~bundled, $0.021 over | $0.09/GB over 250 GB | 1 GB | Yes — signed upload URLs, RLS auth | OK; second vendor, but auth-integrated |

**Recommendation:** **Start on Vercel Blob** for the MVP (least code, native client uploads, no new IAM/CORS), behind the adapter; **plan a migration to Cloudflare R2** once egress/storage volume grows because R2's **zero egress** + $0.015/GB is materially cheaper for a download-heavy CRM (users repeatedly viewing attachments/thumbnails). Avoid S3 as primary purely on $0.09/GB egress unless an AWS-only feature (Textract, SES inbound) is needed. The adapter makes Blob→R2 a config swap, not a rewrite.

**Reference evidence:**
- Egress: S3 ~$0.09/GB, R2 **$0/GB**, Supabase $0.09/GB over 250 GB — [adamarant: R2 vs S3 vs Supabase 2026](https://adamarant.com/en/blog/cloudflare-r2-vs-s3-vs-supabase-storage-in-2026-which-to-pick), [buildmvpfast cloud storage costs](https://www.buildmvpfast.com/api-costs/cloud-storage)
- Vercel Blob pricing: $0.023/GB storage, $0.05/GB transfer, 1GB+10GB Hobby, 5TB max file — [Vercel Blob usage & pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Vercel announcement](https://x.com/vercel/status/1925632672488968683)
- R2 free tier (10GB, 1M Class-A, 10M Class-B) + zero egress — [Cloudflare R2 product](https://www.cloudflare.com/products/r2/), [ThemeDev R2 pricing 2026](https://themedev.net/blog/cloudflare-r2-pricing/)
- R2 is S3-compatible for SDKs — [Cloudflare R2 / AWS SigV4](https://www.bennadel.com/blog/4735-exploring-cloudflare-r2-and-request-authorization-using-aws-signature-v4.htm)

**Effort:** S (pick + provision + adapter stub). **Deps:** env vars in `src/env.ts`; provider account.
**Tier:** **Foundation** (blocks everything else).

---

## Capability 2 — Direct / presigned client-side uploads (bypass the 4.5MB limit)

**What it enables:** users upload files of any size directly browser→storage, never routing bytes through a Vercel function, so we avoid `413 FUNCTION_PAYLOAD_TOO_LARGE`. The function only mints a short-lived, constrained token and records metadata.

**Design — token-exchange flow (provider-agnostic):**

1. **Client** picks a file → calls a server action `requestUploadToken({ entityType, entityId, filename, contentType, size })`.
2. **Server action** (`"use server"`): `requireOrg()`; verify the target record exists and is in-org (`findFirst({ where: { id: entityId, orgId } })`); validate `contentType`/`size` against allowlist + quota (caps 6); create an `Attachment` row with `status: PENDING`; return a **scoped upload token / presigned POST**.
   - **Vercel Blob:** route handler using `handleUpload` from `@vercel/blob/client`; in `onBeforeGenerateToken` set `allowedContentTypes`, `maximumSizeInBytes`, and embed `{ orgId, attachmentId }` in `tokenPayload`. `onUploadCompleted` fires server-side after upload to flip status (note: this callback **cannot reach `localhost`** in dev — use a tunnel or a manual `confirmUpload` action locally).
   - **S3 / R2:** `createPresignedPost({ Bucket, Key, Conditions: [["content-length-range", 1, MAX], ["starts-with","$Content-Type", allowed]], Expires: 60 })`. Key = `org/{orgId}/{entityType}/{entityId}/{attachmentId}/{filename}`.
3. **Client** uploads directly to the returned URL (Blob `put(..., { access:'public'|'private', handleUploadUrl })` or HTML form POST to S3/R2).
4. **Confirmation:** Blob `onUploadCompleted` webhook **or** an explicit `confirmUpload(attachmentId)` action flips `status → CLEAN/READY` (or `SCANNING`, see cap 5) and stores final `size`/`key`. **Never trust client-reported size** — re-`headObject` server-side to get the true byte size before counting it against quota.

```
[browser] --requestUploadToken--> [server action: authz + Attachment(PENDING) + token]
[browser] ----------- PUT/POST bytes (≤? presigned conditions) -----------> [Blob/S3/R2]
[storage] --onUploadCompleted webhook / client confirmUpload--> [server: headObject, status=READY]
```

**Reference evidence:**
- 4.5MB body limit + `413` + recommended fix = client uploads / presigned URLs — [Vercel functions limits](https://vercel.com/docs/functions/limitations), [Vercel KB bypass guide](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- Blob client-upload token exchange (`handleUpload`, secure browser→Blob, no anonymous writes) — [Vercel KB bypass guide](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)
- S3/R2 presigned POST with `content-length-range` + `starts-with $Content-Type`, short `Expires` — [S3 generate_presigned_post](https://docs.aws.amazon.com/botocore/latest/reference/services/s3/client/generate_presigned_post.html), [oneuptime presigned POST guide](https://oneuptime.com/blog/post/2026-02-12-generate-presigned-post-requests-s3-uploads/view), [R2 presigned uploads with Hono](https://lirantal.com/blog/cloudflare-r2-presigned-url-uploads-hono)

**Effort:** M. **Deps:** cap 1 (provider), `Attachment` model (cap 3), CORS config on bucket (S3/R2).
**Tier:** **Foundation** (no usable upload without it).

---

## Capability 3 — Polymorphic `Attachment` model (orgId-scoped)

**What it enables:** one table links any file to any record type (contact, company, deal, activity, future email/org-logo) with full tenant isolation and an audit trail, instead of N per-entity tables.

**Design — Prisma sketch (additive migration):**

```prisma
enum AttachmentEntity {
  CONTACT
  COMPANY
  DEAL
  ACTIVITY
  EMAIL        // reserved — no Email model yet
  ORGANIZATION // logos / shared docs
}

enum AttachmentStatus {
  PENDING   // token issued, bytes not confirmed
  SCANNING  // uploaded, awaiting AV result
  READY     // clean + downloadable
  INFECTED  // quarantined
  FAILED    // upload/scan error
}

enum StorageProvider {
  VERCEL_BLOB
  S3
  R2
  SUPABASE
}

model Attachment {
  id          String           @id @default(cuid())
  orgId       String

  // polymorphic target — no DB-level FK; integrity enforced in app layer
  entityType  AttachmentEntity
  entityId    String

  provider    StorageProvider  @default(VERCEL_BLOB)
  bucket      String?          // null for Blob
  key         String           // object key / pathname (source of truth, not URL)

  filename    String           // original, user-facing
  contentType String
  size        Int              // bytes, set server-side from headObject (NOT client)
  checksum    String?          // sha256 for dedupe/integrity
  status      AttachmentStatus @default(PENDING)
  scanResult  String?          // AV engine + signature when INFECTED

  // image-derived (cap 7)
  width       Int?
  height      Int?
  thumbnailKey String?

  uploadedById String?
  org          Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  uploadedBy   User?        @relation(fields: [uploadedById], references: [id], onDelete: SetNull)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([orgId, entityType, entityId])   // "list attachments for this record"
  @@index([orgId, status])                  // quota sum / scan sweeps
  @@index([orgId, createdAt])
}
```

**Why polymorphic (not per-entity FK):** keeps schema flat, lets a new attachable type (Email) be a new enum value with zero migrations on existing tables, and centralizes access/quota logic. Trade-off: **no DB referential integrity** to the parent → enforce existence in the server action (`findFirst({ id: entityId, orgId })`) and run a periodic orphan-sweep when parents are deleted (parents currently `onDelete: SetNull`/`Cascade` only their own relations, so attachments must be cleaned by app logic — add deletion to each entity's `delete*` action, or a cron). Add the back-relation `attachments Attachment[]` to `Organization` and `User`.

**Reference evidence:** matches existing repo conventions — orgId scoping + `findFirst({ id, orgId })` in `src/server/actions/contacts.ts`; cascade pattern in `prisma/schema.prisma`. Polymorphic-association trade-offs (no FK, app-enforced integrity) are a well-known Rails/Prisma pattern.

**Effort:** S (one migration + back-relations). **Deps:** none (can land before provider).
**Tier:** **Foundation**.

---

## Capability 4 — Access control on download (signed URLs + permission checks)

**What it enables:** files are private by default; only authorized in-org users get time-limited download links — no public/guessable object URLs leaking CRM data across tenants.

**Design:**
- **Store objects private** (Blob `access: 'private'`; S3/R2 buckets block all public access, no public ACLs).
- **Download path:** a server action / route `getAttachmentUrl(attachmentId)`:
  1. `requireOrg()`; load `Attachment` via `findFirst({ where: { id, orgId } })` → cross-tenant access impossible (returns null).
  2. Permission check: any member can read; gate **delete** behind `requireRole(role, "ADMIN")` (or "uploader-or-admin"). Optionally check the parent record is still in-org.
  3. Reject if `status !== READY` (don't serve `PENDING`/`INFECTED`).
  4. Return a **short-lived signed URL** (`getSignedUrl(GetObjectCommand, { expiresIn: 60 })` for S3/R2; Blob private download token). Never persist the signed URL.
- **Defense in depth:** key namespacing `org/{orgId}/...` so even a leaked key is org-bounded; consider a `Content-Disposition: attachment` response param on the presign to force download (mitigates stored-XSS via HTML/SVG served inline).
- **Audit (optional):** log downloads to an `ActivityLog` if/when that exists.

**Reference evidence:**
- Presigned GET with short `expiresIn` for controlled, temporary read access — [S3/R2 presigned URL access control via Workers](https://blog.dankying.com/en/posts/20250429-how-to-build-an-image-service-using-cloudflare-workers/), [R2 presigned uploads & reads](https://lirantal.com/blog/cloudflare-r2-presigned-url-uploads-hono)
- Existing tenant-isolation pattern (`findFirst({ id, orgId })`) — `src/server/actions/contacts.ts`; RBAC `requireRole` — `src/lib/rbac.ts`.

**Effort:** S–M. **Deps:** caps 1 + 3.
**Tier:** **Foundation** (security-critical; ship with cap 2/3).

---

## Capability 5 — Virus scanning + quarantine

**What it enables:** uploaded files are scanned for malware before any user can download them, so the CRM can't become a malware-distribution vector between users/orgs.

**Design — incoming → scanning → clean/quarantine:**
- On confirmed upload, set `status: SCANNING`; do **not** issue download URLs until `READY`.
- **Async scan trigger:**
  - **S3/R2 path:** object-create event → Lambda (or Worker) running **ClamAV** (Docker image); a second scheduled job (EventBridge) refreshes virus definitions. On result: clean → flip `status: READY`; infected → move to a **quarantine** key/bucket, set `status: INFECTED` + `scanResult`, optionally SNS/alert. Enable **bucket versioning** so a clean file can't be silently swapped for a tainted one.
  - **Vercel Blob path:** no native event→Lambda. Call a scanning API (e.g. a hosted ClamAV/`lambda-virus-scanner` endpoint or a SaaS like VirusTotal/Cloudmersive) from `onUploadCompleted`, or a queue worker; flip status on callback.
- **MVP fallback:** if standing up ClamAV infra is too heavy for v1, gate by strict type/size allowlist (cap 6) + private-only delivery + force-download disposition, and add scanning as a fast-follow. Document the residual risk.

**Reference evidence:**
- Incoming/clean/quarantine ClamAV-on-Lambda via S3 events, EventBridge def-updates, **versioning to prevent swap** — [AWS Dev Tools blog: serverless ClamAV S3 scan](https://aws.amazon.com/blogs/developer/virus-scan-s3-buckets-with-a-serverless-clamav-based-cdk-construct/), [businesscompass ClamAV on AWS](https://businesscompassllc.com/deploying-a-scalable-serverless-malware-scanning-solution-with-clamav-on-aws/), [Serverless Guru: secure S3 upload + Lambda scan](https://www.sls.guru/blog/secure-file-upload-to-amazon-s3-with-aws-lambda-virus-scanning-serverless-architecture-guide)
- Reusable scanner — [opengovsg/lambda-virus-scanner](https://github.com/opengovsg/lambda-virus-scanner)

**Effort:** M (S3/R2 event→Lambda) / L (Blob, no native events → bespoke pipeline). **Deps:** caps 1–4.
**Tier:** **Core** (Foundation if handling untrusted/regulated data).

---

## Capability 6 — Size/type limits + per-plan quotas

**What it enables:** caps abuse and cost — rejects oversized/disallowed files at token time, and enforces a total-storage ceiling per organization based on its plan.

**Design:**
- **Type allowlist:** central `ALLOWED_MIME` set (pdf, common images, office docs, csv, txt…); reject SVG/HTML or force-download to avoid inline-script XSS. Validate at token issue **and** in the presigned conditions (`starts-with $Content-Type`) so the bucket itself rejects mismatches.
- **Per-file size cap:** e.g. 25 MB default; encode in `maximumSizeInBytes` (Blob) / `content-length-range` (S3/R2) so the **storage layer** enforces it even if the client lies.
- **Per-org quota:** since there is **no `Plan` model yet**, add a minimal one (or a `storageQuotaBytes` column on `Organization` defaulting to a free-tier value). On token issue, compute used bytes = `SELECT SUM(size) FROM Attachment WHERE orgId=? AND status IN (READY,SCANNING)` (the `@@index([orgId, status])` supports this) and reject if `used + newSize > quota`. Recompute from true `headObject` size after upload; surface usage on a settings/usage screen.

```
Plan tiers (illustrative): FREE 1GB / PRO 50GB / ENTERPRISE custom
Per-file: 25MB default; configurable per plan.
```

**Reference evidence:**
- Per-tenant storage quotas + metering + reject/throttle on overage as standard SaaS practice — [easecloud multi-tenant cost control](https://blog.easecloud.io/cost-optimization/multi-tenant-saas-cost-control-strategies/), [STOA per-tenant rate limiting](https://docs.gostoa.dev/blog/saas-playbook-2-rate-limiting-saas)
- Storage-enforced size/type via presigned conditions — [S3 generate_presigned_post](https://docs.aws.amazon.com/botocore/latest/reference/services/s3/client/generate_presigned_post.html); Blob `maximumSizeInBytes`/`allowedContentTypes` — [Vercel KB bypass guide](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)

**Effort:** M (S for limits alone; +M for a `Plan`/quota model + usage rollup). **Deps:** cap 3; ideally a billing/plan concept.
**Tier:** **Core**.

---

## Capability 7 — Image transforms / thumbnails

**What it enables:** fast-loading avatars and inline previews (contact/company logos, image attachments) without shipping full-resolution files on every list/detail view — also cuts egress.

**Design:**
- **Avatars first:** replace the free-text `User.image` URL and add `Company.logoKey`/`Contact.avatarKey` (or reuse `Attachment` with `entityType` = the record + a `kind` convention) so avatars go through the same private-upload+signed-download pipeline.
- **Thumbnail generation:** on upload-complete for image MIME types, generate a small derivative and store its key in `Attachment.thumbnailKey` (+ `width`/`height`). Options:
  - **R2 + Cloudflare Images / Image Resizing** — transform on the fly at the edge (`/cdn-cgi/image/...`), no derivative storage.
  - **S3 + Lambda@Edge / sharp** — generate-on-write or on-read.
  - **Vercel** — Next.js `<Image>` + `next/image` optimization for the *display* layer; for true source thumbnails, a `sharp`-based resize in the confirm step (mind the function memory/time + 4.5MB **response** limit → stream/redirect to the object, don't return bytes through the function).
- Serve thumbnails via the same signed-URL access control (cap 4).

**Reference evidence:**
- R2 is S3-API compatible and commonly paired with Cloudflare Workers/Images for edge image serving/transforms — [Cloudflare Workers image service on R2](https://blog.dankying.com/en/posts/20250429-how-to-build-an-image-service-using-cloudflare-workers/), [Cloudflare R2 product](https://www.cloudflare.com/products/r2/)
- Cloudinary/edge transform pattern for Vercel uploads — [Cloudinary: upload images with Vercel functions](https://cloudinary.com/blog/upload-images-with-vercel-serverless-functions)

**Effort:** M. **Deps:** caps 1–4; image lib (`sharp`) or edge transform service.
**Tier:** **Core** (avatars) / **Strategic Bet** (full transform pipeline).

---

## Capability 8 — Path to document features (templates → e-sign)

**What it enables:** moves from "files attached to records" toward "documents generated/signed inside the CRM" — quotes, proposals, contracts — a defensible, higher-tier feature set.

**Design (incremental, builds on `Attachment`):**
- **Phase A — Document templates:** a `DocumentTemplate` model (orgId-scoped, body with merge tokens like `{{contact.firstName}}`, `{{deal.value}}`). "Generate" renders template + record data → PDF (server-side renderer or a service) → stored as an `Attachment` (`entityType: DEAL`, e.g.). Reuses upload/quota/access machinery.
- **Phase B — Versioning:** add `Attachment.version` / a `DocumentVersion` child table so regenerations don't clobber prior PDFs (pairs with bucket versioning from cap 5).
- **Phase C — E-signature:** integrate a provider (DocuSign / Dropbox Sign / signable open-source); model `SignatureRequest { attachmentId, signerEmail, status, signedAt, externalId }`; provider webhook updates status and stores the signed PDF back as a new `Attachment` version. Keep it provider-adapter-shaped like cap 1.

**Reference evidence:** greenfield (no doc features in repo today); design intentionally layers on caps 1–6 so no new storage primitives are required — only new metadata models + a render/e-sign provider. (Provider/API specifics deferred to a dedicated brief.)

**Effort:** L (multi-phase). **Deps:** caps 1–7; PDF render + e-sign vendor.
**Tier:** **Strategic Bet**.

---

## Summary table

| # | Capability | Effort | Tier |
|---|---|---|---|
| 1 | Object storage provider (Blob now → R2 later, behind adapter) | S | Foundation |
| 2 | Presigned/direct client uploads (bypass 4.5MB) | M | Foundation |
| 3 | Polymorphic `Attachment` model (orgId-scoped) | S | Foundation |
| 4 | Signed-URL download + permission checks | S–M | Foundation |
| 5 | Virus scanning + quarantine | M–L | Core |
| 6 | Size/type limits + per-plan quotas | M | Core |
| 7 | Image transforms / thumbnails | M | Core / Strategic |
| 8 | Document templates → e-sign path | L | Strategic Bet |

---

## Top 3 picks

1. **Polymorphic `Attachment` model + presigned client uploads (caps 3 + 2)** — the non-negotiable core. The 4.5MB Vercel body limit means uploads *must* go browser→storage via a token exchange, and one orgId-scoped polymorphic table cleanly attaches files to contacts/companies/deals/activities (and future emails) while matching the repo's existing `findFirst({ id, orgId })` isolation pattern.
2. **Object storage on Vercel Blob behind a swappable adapter, with signed-URL access control (caps 1 + 4)** — ship fastest on Blob's native `handleUpload` (no IAM/CORS), keep objects private, serve only short-lived signed URLs gated by `requireOrg()`/`requireRole()`, and store `provider`+`key` (not URLs) so migrating to **Cloudflare R2** (zero egress, $0.015/GB) later is a config change, not a rewrite.
3. **Size/type limits + per-plan quotas (cap 6)** — cheap insurance against cost blowups and abuse; enforce per-file caps in the presigned conditions (storage-layer enforced) and a per-org `SUM(size)` quota, which also forces the first real **Plan/billing** primitive the app currently lacks. (Virus scanning is the next thing right after, before exposing downloads of untrusted files.)
