"use client";
import { useRef } from "react";
import { useRouter } from "next/navigation";
import { useOrgChannel } from "@/lib/use-realtime";

/**
 * Live collaboration for the Kanban board (M17). Subscribes to the org's
 * realtime channel and, on a relevant deal event, debounces a router.refresh()
 * so other viewers see the board update. Refreshing (rather than mutating client
 * state) respects the deal's OCC `version` — the server re-renders the canonical
 * board. Inert when NEXT_PUBLIC_PUSHER_KEY is unset (useOrgChannel no-ops).
 *
 * Renders nothing; it is a behavior-only mount point.
 */

// Deal events worth re-fetching the board for.
const REFRESH_EVENTS = new Set(["deal.created", "deal.stage_changed", "deal.status_changed"]);

const DEBOUNCE_MS = 400;

export function LiveRefresh({ orgId }: { orgId: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useOrgChannel(orgId, (name) => {
    if (!REFRESH_EVENTS.has(name)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), DEBOUNCE_MS);
  });

  return null;
}
