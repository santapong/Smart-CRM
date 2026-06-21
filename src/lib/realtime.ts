import type Pusher from "pusher";

/**
 * Real-time collaboration backbone (M17), powered by Pusher Channels.
 *
 * Fully env-gated, exactly like Slack (M15) / AI (M14): with no PUSHER_* vars the
 * app still builds and runs — {@link realtimeConfigured} is false, {@link publish}
 * is a safe no-op, and {@link authorizeChannel} returns null. The heavy `pusher`
 * server SDK is loaded via a lazy dynamic import() so the bundle stays lean and
 * nothing is imported when realtime is off.
 *
 * Channel-name helpers are PURE (no env, no I/O) so they unit-test trivially.
 * Fan-out happens post-commit in the outbox drain (src/inngest/functions.ts via
 * src/lib/events.ts), never inside a transaction.
 */

/** True when ALL Pusher server env vars are present. */
export function realtimeConfigured(): boolean {
  return Boolean(
    process.env.PUSHER_APP_ID &&
      process.env.PUSHER_KEY &&
      process.env.PUSHER_SECRET &&
      process.env.PUSHER_CLUSTER,
  );
}

/** Private channel carrying every domain event for an org. */
export function orgChannel(orgId: string): string {
  return `private-org-${orgId}`;
}

/** Presence channel tracking who is online in an org. */
export function presenceChannel(orgId: string): string {
  return `presence-org-${orgId}`;
}

/** Info echoed to presence members. Kept minimal (no PII beyond a display name). */
export type PresenceUserInfo = { name: string };

// Memoized singleton, mirroring the lazy client in src/lib/ai.ts. `undefined`
// means "not yet resolved"; `null` means "resolved, but not configured".
let cached: Pusher | null | undefined;

/**
 * Lazily construct the Pusher server client via dynamic import(). Returns null
 * (and imports nothing) when realtime is not configured. Defensive: a failed
 * import/construction degrades to null rather than throwing.
 */
async function getServerClient(): Promise<Pusher | null> {
  if (cached !== undefined) return cached;
  if (!realtimeConfigured()) {
    cached = null;
    return cached;
  }
  try {
    const { default: PusherServer } = await import("pusher");
    cached = new PusherServer({
      appId: process.env.PUSHER_APP_ID as string,
      key: process.env.PUSHER_KEY as string,
      secret: process.env.PUSHER_SECRET as string,
      cluster: process.env.PUSHER_CLUSTER as string,
      useTLS: true,
    });
  } catch (err) {
    console.error("realtime: failed to init Pusher client", err);
    cached = null;
  }
  return cached;
}

/** Reset the memoized client. Test-only seam; never used in app code. */
export function _resetRealtimeForTests(): void {
  cached = undefined;
}

/**
 * Publish an event to a channel. Best-effort: a no-op (resolves, no network
 * call) when realtime is unconfigured, and never throws on failure — Pusher
 * errors are logged and swallowed so this can sit inside the outbox drain next
 * to the webhook/Slack fan-out.
 */
export async function publish(channel: string, event: string, payload: unknown): Promise<void> {
  const client = await getServerClient();
  if (!client) return;
  try {
    await client.trigger(channel, event, payload);
  } catch (err) {
    console.error("realtime: publish failed", { channel, event }, err);
  }
}

/**
 * Authorize a socket for a private/presence channel. Returns the Pusher auth
 * payload (to hand back to the browser SDK) when configured, or null when not.
 * The caller (the /api/realtime/auth route) is responsible for verifying the
 * channel is scoped to the user's own org BEFORE calling this.
 */
export async function authorizeChannel(
  socketId: string,
  channel: string,
  user: { id: string; info: PresenceUserInfo },
): Promise<unknown | null> {
  const client = await getServerClient();
  if (!client) return null;
  if (channel.startsWith("presence-")) {
    return client.authorizeChannel(socketId, channel, {
      user_id: user.id,
      user_info: user.info,
    });
  }
  return client.authorizeChannel(socketId, channel);
}
