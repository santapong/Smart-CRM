"use client";
import { usePresence } from "@/lib/use-realtime";
import { initials } from "@/lib/utils";

/**
 * Online-members strip (M17). Shows a small stack of avatars for everyone
 * currently viewing, via the org's presence channel. Renders nothing when
 * realtime is unconfigured (usePresence returns []) — so the deals page is
 * unchanged with no Pusher keys.
 */

const MAX_VISIBLE = 5;

export function PresenceAvatars({ orgId }: { orgId: string }) {
  const members = usePresence(orgId);
  if (members.length === 0) return null;

  const visible = members.slice(0, MAX_VISIBLE);
  const overflow = members.length - visible.length;

  return (
    <div className="flex items-center gap-2" aria-label="Online now">
      <div className="flex -space-x-2">
        {visible.map((m) => (
          <span
            key={m.id}
            title={m.name}
            className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-secondary text-[11px] font-semibold text-secondary-foreground"
          >
            {initials(m.name)}
          </span>
        ))}
        {overflow > 0 && (
          <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-background bg-muted text-[11px] font-medium text-muted-foreground">
            +{overflow}
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        {members.length} online
      </span>
    </div>
  );
}
