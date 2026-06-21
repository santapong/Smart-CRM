/**
 * SSO (SAML) + SCIM scaffold (M16) — fully env-gated, no heavy deps.
 *
 * The real, production SAML/SCIM flow is intended to run through BoxyHQ Jackson,
 * which needs its own datastore. To keep the build/tests green with zero extra
 * infra we DO NOT install that package here. Instead:
 *  - SAML IdP metadata is stored on the per-org `SSOConnection` model.
 *  - `ssoConfigured()` reports whether the JACKSON_* env wiring is present.
 *  - The /api/auth/sso and /api/scim/v2 routes return 501 until it is.
 *
 * TODO: wire BoxyHQ Jackson when JACKSON_* env is provided.
 */

export type SsoNotConfigured = { configured: false; reason: string };

export type SsoConfig = {
  configured: true;
  /** Jackson controller base URL. */
  url: string;
  /** Optional API key for the Jackson management API. */
  apiKey?: string;
};

const REASON = "Set JACKSON_URL (and JACKSON_API_KEY) to enable SSO/SCIM.";

/** Read SSO config from the environment (kept here so callers stay simple). */
export function ssoEnv() {
  return {
    url: process.env.JACKSON_URL,
    apiKey: process.env.JACKSON_API_KEY,
  };
}

/** True when the SSO/SCIM backbone (BoxyHQ Jackson) is wired up. */
export function ssoConfigured(): boolean {
  return Boolean(process.env.JACKSON_URL);
}

/**
 * Return the live SSO config, or a not-configured result (and never any network
 * call) when JACKSON_URL is unset. Mirrors the Nango helper shape (M15).
 */
export function getSsoConfig(): SsoConfig | SsoNotConfigured {
  if (!ssoConfigured()) return { configured: false, reason: REASON };
  const { url, apiKey } = ssoEnv();
  return { configured: true, url: url as string, apiKey };
}

/** Human-readable hint shown in the UI when SSO is not configured. */
export const SSO_NOT_CONFIGURED_REASON = REASON;
