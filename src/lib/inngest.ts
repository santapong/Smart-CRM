import { Inngest } from "inngest";

/**
 * Shared Inngest client (M2). Works without any API keys in local dev — the
 * INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are only needed to talk to Inngest
 * Cloud. The transactional outbox (see src/lib/events.ts) is the source of
 * truth; Inngest just drains it on a cron.
 */
export const inngest = new Inngest({ id: "smart-crm" });
