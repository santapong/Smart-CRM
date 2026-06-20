/**
 * Error monitoring (M1) — env-gated.
 *
 * Next.js 15 calls `register()` once per server runtime at startup. We only
 * initialize Sentry when `SENTRY_DSN` is set, via a dynamic import so the SDK
 * is never loaded (and the build never needs an auth token / source-map upload)
 * when monitoring is disabled. The app builds and runs with no DSN.
 *
 * Note: this intentionally does NOT use `withSentryConfig` / the source-map
 * webpack plugin, which would require SENTRY_AUTH_TOKEN and break offline builds.
 */

export async function register(): Promise<void> {
  if (!process.env.SENTRY_DSN) return;

  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      enabled: true,
    });
  }
}

/**
 * Next.js `onRequestError` hook (App Router). Forwards server errors to Sentry
 * when configured; a no-op otherwise.
 */
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
): Promise<void> {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureRequestError(...args);
}
