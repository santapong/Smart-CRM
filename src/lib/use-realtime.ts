"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Client-side realtime hooks (M17), powered by Pusher Channels.
 *
 * Fully env-gated by NEXT_PUBLIC_PUSHER_KEY: when it is absent both hooks are
 * inert (subscribe to nothing, do no work, return empty) and — crucially — the
 * `pusher-js` chunk is NEVER dynamically imported, so the client bundle stays
 * lean and the app runs with no Pusher keys. The dynamic import() lives behind
 * the env check so bundlers split it into its own lazily-fetched chunk.
 *
 * Channel names mirror the pure server helpers (src/lib/realtime.ts):
 *   private-org-<orgId>  — every domain event for the org
 *   presence-org-<orgId> — who is online
 * Auth is delegated to /api/realtime/auth (session-scoped, org-isolated).
 */

/** A member surfaced by the presence channel. */
export type PresenceMember = { id: string; name: string };

function pusherKey(): string | undefined {
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  return key && key.length > 0 ? key : undefined;
}

function pusherCluster(): string {
  return process.env.NEXT_PUBLIC_PUSHER_CLUSTER || "mt1";
}

/**
 * Subscribe to the org's private channel and invoke `onEvent(name, payload)` for
 * every event bound on it. No-op (returns, subscribes to nothing) when
 * NEXT_PUBLIC_PUSHER_KEY is unset. Cleans up the subscription on unmount or when
 * orgId changes.
 */
export function useOrgChannel(
  orgId: string | null | undefined,
  onEvent?: (name: string, payload: unknown) => void,
): void {
  // Keep the latest callback in a ref so resubscribes don't churn on every render.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const key = pusherKey();
    if (!key || !orgId) return;

    let cancelled = false;
    // Holds the cleanup closure once the (async) subscription is established.
    let cleanup: (() => void) | undefined;

    void (async () => {
      const { default: Pusher } = await import("pusher-js");
      if (cancelled) return;
      const client = new Pusher(key, {
        cluster: pusherCluster(),
        authEndpoint: "/api/realtime/auth",
      });
      const channel = client.subscribe(`private-org-${orgId}`);
      // bind_global fires for every event on the channel; ignore Pusher's own
      // internal pusher:* lifecycle events.
      const onAny = (eventName: string, data: unknown) => {
        if (eventName.startsWith("pusher:") || eventName.startsWith("pusher_internal:")) return;
        handlerRef.current?.(eventName, data);
      };
      channel.bind_global(onAny);
      cleanup = () => {
        channel.unbind_global(onAny);
        client.unsubscribe(`private-org-${orgId}`);
        client.disconnect();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [orgId]);
}

type PresenceChannelLike = {
  members: { each: (cb: (m: { id: string; info?: { name?: string } }) => void) => void };
  bind: (event: string, cb: (...args: unknown[]) => void) => void;
};

/**
 * Subscribe to the org's presence channel and return the list of online members.
 * Returns `[]` (and subscribes to nothing) when NEXT_PUBLIC_PUSHER_KEY is unset.
 */
export function usePresence(orgId: string | null | undefined): PresenceMember[] {
  const [members, setMembers] = useState<PresenceMember[]>([]);

  useEffect(() => {
    const key = pusherKey();
    if (!key || !orgId) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const { default: Pusher } = await import("pusher-js");
      if (cancelled) return;
      const client = new Pusher(key, {
        cluster: pusherCluster(),
        authEndpoint: "/api/realtime/auth",
      });
      const channelName = `presence-org-${orgId}`;
      const channel = client.subscribe(channelName) as unknown as PresenceChannelLike;

      const snapshot = () => {
        if (cancelled) return;
        const next: PresenceMember[] = [];
        channel.members.each((m) => next.push({ id: m.id, name: m.info?.name ?? "Member" }));
        // De-dupe by id (a member can have multiple connections).
        const byId = new Map(next.map((m) => [m.id, m]));
        setMembers(Array.from(byId.values()));
      };

      channel.bind("pusher:subscription_succeeded", snapshot);
      channel.bind("pusher:member_added", snapshot);
      channel.bind("pusher:member_removed", snapshot);

      cleanup = () => {
        client.unsubscribe(channelName);
        client.disconnect();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [orgId]);

  return members;
}
