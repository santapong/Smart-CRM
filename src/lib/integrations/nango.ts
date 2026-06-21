import { isNangoConfigured } from "@/lib/integrations/registry";

/**
 * Nango (managed OAuth) helpers (M15). Fully env-gated and side-effect free:
 * with no `NANGO_SECRET_KEY` everything returns a `{ configured: false }`
 * result and NO network call is ever made. When a key is present we surface the
 * non-secret connect info (host + a per-connection id) the browser SDK needs to
 * start an OAuth flow — building a live Connect session is left to a later
 * milestone, so even the configured path here does no live calls.
 *
 * This keeps Gmail / Google Calendar "scaffolded": the wiring and UI exist, but
 * builds/tests pass with no integration keys.
 */

export type NangoNotConfigured = { configured: false; reason: string };

export type NangoConnectInfo = {
  configured: true;
  /** Nango API host (defaults to the public cloud). */
  host: string;
  /** The integration id in Nango (matches our provider key by convention). */
  providerConfigKey: string;
  /** A stable, org-scoped connection id to pass to the frontend SDK. */
  connectionId: string;
};

const DEFAULT_HOST = "https://api.nango.dev";

/** Read Nango config from the environment (kept here so callers stay simple). */
export function nangoEnv() {
  return {
    secretKey: process.env.NANGO_SECRET_KEY,
    host: process.env.NANGO_HOST || DEFAULT_HOST,
  };
}

/**
 * Build the non-secret info the frontend needs to launch an OAuth connect flow
 * for `provider` on behalf of `orgId`. Returns not-configured (and makes no
 * network call) when NANGO_SECRET_KEY is unset.
 */
export function buildConnectInfo(
  orgId: string,
  provider: string,
): NangoConnectInfo | NangoNotConfigured {
  if (!isNangoConfigured(process.env)) {
    return { configured: false, reason: "Set NANGO_SECRET_KEY to enable OAuth integrations." };
  }
  const { host } = nangoEnv();
  return {
    configured: true,
    host,
    providerConfigKey: provider,
    // Deterministic per org+provider so re-connects target the same record.
    connectionId: `${orgId}:${provider}`,
  };
}

/** Convenience predicate mirroring the registry helper. */
export function nangoConfigured(): boolean {
  return isNangoConfigured(process.env);
}
