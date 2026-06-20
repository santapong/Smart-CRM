/**
 * Integration provider registry (M15). A static catalog of the third-party
 * providers the CRM can connect to, plus a `configured(env)` predicate that
 * reports whether the server has the env wiring needed to use each one.
 *
 * Everything here is metadata only — no secrets, no network. Server actions and
 * the /settings/integrations page read this to render provider cards and gate
 * "Connect" buttons. Keys match `Connection.provider`.
 */

/** How a provider is authenticated. */
export type IntegrationAuthType = "webhook" | "oauth" | "api";

/** A subset of process.env, passed in so the predicate stays pure/testable. */
export type IntegrationEnv = Record<string, string | undefined>;

export type IntegrationProvider = {
  key: string;
  name: string;
  description: string;
  authType: IntegrationAuthType;
  /** Marketing/UX status: "live" works today; "scaffolded" needs env wiring. */
  status: "live" | "scaffolded";
  /** True when the server has what it needs to use this provider. */
  configured: (env: IntegrationEnv) => boolean;
};

/** True when Nango (managed OAuth) is wired up. */
export function isNangoConfigured(env: IntegrationEnv): boolean {
  return Boolean(env.NANGO_SECRET_KEY);
}

export const INTEGRATIONS: IntegrationProvider[] = [
  {
    key: "slack",
    name: "Slack",
    description:
      "Post deal and lead alerts to a Slack channel via an incoming webhook URL.",
    authType: "webhook",
    status: "live",
    // Slack is configured per-connection (a stored webhook URL), so it is
    // always usable — no server env needed.
    configured: () => true,
  },
  {
    key: "gmail",
    name: "Gmail",
    description:
      "Sync and send email through a connected Gmail account (OAuth via Nango).",
    authType: "oauth",
    status: "scaffolded",
    configured: (env) => isNangoConfigured(env),
  },
  {
    key: "google_calendar",
    name: "Google Calendar",
    description: "Two-way sync of meetings and activities (OAuth via Nango).",
    authType: "oauth",
    status: "scaffolded",
    configured: (env) => isNangoConfigured(env),
  },
  {
    key: "zapier",
    name: "Zapier",
    description:
      "Connect 6,000+ apps using the public REST API and outbound webhooks.",
    authType: "api",
    status: "live",
    // Powered by the M12 public API + webhooks, which always exist.
    configured: () => true,
  },
];

/** Look up a provider by its registry key. */
export function getProvider(key: string): IntegrationProvider | undefined {
  return INTEGRATIONS.find((p) => p.key === key);
}
