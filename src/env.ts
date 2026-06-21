import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    DIRECT_URL: z.string().url().optional(),
    AUTH_SECRET: z.string().min(16),
    AUTH_URL: z.string().url().optional(),
    AUTH_TRUST_HOST: z.preprocess((v) => v === "true" || v === true, z.boolean().optional()),
    EMAIL_FROM: z.string().email().optional(),
    RESEND_API_KEY: z.string().optional(),
    // Email webhook (M7) — env-gated; the webhook route is a 200 no-op unset.
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    // Async backbone (M2) — only needed to talk to Inngest Cloud.
    INNGEST_EVENT_KEY: z.string().optional(),
    INNGEST_SIGNING_KEY: z.string().optional(),
    // Billing (M4) — env-gated; app runs without these.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    // Rate limiting (M1) — env-gated; falls back to a no-op limiter when unset.
    UPSTASH_REDIS_REST_URL: z.string().url().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    // Error monitoring (M1) — env-gated; Sentry stays off unless a DSN is set.
    SENTRY_DSN: z.string().optional(),
    // AI assistant (M14) — env-gated; with no key the assistant returns a
    // graceful "AI is not configured" result. AI_MODEL overrides the default.
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional(),
    // Integrations framework (M15) — all env-gated.
    // Secrets vault key: base64-encoded 32 bytes. When unset, src/lib/crypto.ts
    // falls back to a clearly-labeled DEV-ONLY key so local/test still works.
    ENCRYPTION_KEY: z.string().optional(),
    // Nango (managed OAuth) — only needed to enable Gmail/Calendar connect.
    // With no key the OAuth providers stay scaffolded/disabled in the UI.
    NANGO_SECRET_KEY: z.string().optional(),
    NANGO_HOST: z.string().url().optional(),
    // SSO/SCIM (M16) — env-gated scaffold. With JACKSON_URL unset the SSO/SCIM
    // routes return 501 and the UI shows a "set JACKSON_* to enable" hint.
    JACKSON_URL: z.string().url().optional(),
    JACKSON_API_KEY: z.string().optional(),
    // Realtime (M17) — Pusher Channels. All env-gated: with these unset the
    // realtime backbone is inert (publish is a no-op, the auth route 501s) and
    // the app builds/runs without them. All four are needed to go live.
    PUSHER_APP_ID: z.string().optional(),
    PUSHER_KEY: z.string().optional(),
    PUSHER_SECRET: z.string().optional(),
    PUSHER_CLUSTER: z.string().optional(),
    // Smart-Docs file storage (M18) — env-gated. With BLOB_READ_WRITE_TOKEN unset
    // the storage adapter (src/lib/storage.ts) falls back to the local filesystem
    // (.uploads/), so uploads work with zero config. Set this to use Vercel Blob.
    BLOB_READ_WRITE_TOKEN: z.string().optional(),
    // eSign (M18) — env-gated scaffold. With DROPBOX_SIGN_API_KEY unset the eSign
    // helpers return "not configured" and the /api/esign/webhook route 501s.
    DROPBOX_SIGN_API_KEY: z.string().optional(),
    // Search (M19a) — env-gated. The live search path is Postgres full-text
    // search (zero config). Set MEILISEARCH_HOST to route through a Meilisearch
    // instance instead; with it unset searchProvider() is "postgres" and the
    // meili adapter (src/lib/search-meili.ts) stays a scaffold. The SDK is NOT
    // bundled (mirrors the SSO/eSign scaffolds).
    MEILISEARCH_HOST: z.string().url().optional(),
    MEILISEARCH_KEY: z.string().optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },
  client: {
    NEXT_PUBLIC_APP_NAME: z.string().default("Smart CRM"),
    // Error monitoring (M1) — env-gated; client SDK stays off unless set.
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
    // Realtime (M17) — public Pusher key + cluster for the browser SDK. With
    // NEXT_PUBLIC_PUSHER_KEY unset the client hooks no-op and the pusher-js
    // chunk is never fetched. Mirror PUSHER_KEY / PUSHER_CLUSTER here.
    NEXT_PUBLIC_PUSHER_KEY: z.string().optional(),
    NEXT_PUBLIC_PUSHER_CLUSTER: z.string().optional(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_URL: process.env.DIRECT_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_URL: process.env.AUTH_URL,
    AUTH_TRUST_HOST: process.env.AUTH_TRUST_HOST,
    EMAIL_FROM: process.env.EMAIL_FROM,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET,
    INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    SENTRY_DSN: process.env.SENTRY_DSN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    NANGO_SECRET_KEY: process.env.NANGO_SECRET_KEY,
    NANGO_HOST: process.env.NANGO_HOST,
    JACKSON_URL: process.env.JACKSON_URL,
    JACKSON_API_KEY: process.env.JACKSON_API_KEY,
    PUSHER_APP_ID: process.env.PUSHER_APP_ID,
    PUSHER_KEY: process.env.PUSHER_KEY,
    PUSHER_SECRET: process.env.PUSHER_SECRET,
    PUSHER_CLUSTER: process.env.PUSHER_CLUSTER,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    DROPBOX_SIGN_API_KEY: process.env.DROPBOX_SIGN_API_KEY,
    MEILISEARCH_HOST: process.env.MEILISEARCH_HOST,
    MEILISEARCH_KEY: process.env.MEILISEARCH_KEY,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_PUSHER_KEY: process.env.NEXT_PUBLIC_PUSHER_KEY,
    NEXT_PUBLIC_PUSHER_CLUSTER: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
  },
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
