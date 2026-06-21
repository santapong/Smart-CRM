import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { realtimeConfigured, authorizeChannel } from "@/lib/realtime";

/**
 * Pusher channel authorization endpoint (M17). The browser SDK POSTs
 * `socket_id` + `channel_name` here (as form-encoded) before joining a
 * private-/presence- channel; we sign the subscription only for channels scoped
 * to the caller's OWN org.
 *
 * Env-gated like the rest of M17: returns 501 when PUSHER_* is unset. This route
 * does its own auth via the session (it is NOT in the public allowlist), so an
 * unauthenticated request or one for another org's channel gets 403.
 */

export const runtime = "nodejs";

/** Parse Pusher's form-encoded (or JSON) auth body into the two fields it sends. */
async function readBody(req: Request): Promise<{ socketId: string; channel: string }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      socketId: typeof json.socket_id === "string" ? json.socket_id : "",
      channel: typeof json.channel_name === "string" ? json.channel_name : "",
    };
  }
  const form = await req.formData().catch(() => null);
  return {
    socketId: form ? String(form.get("socket_id") ?? "") : "",
    channel: form ? String(form.get("channel_name") ?? "") : "",
  };
}

export async function POST(req: Request): Promise<Response> {
  // Env gate first: nothing to sign without Pusher keys.
  if (!realtimeConfigured()) {
    return NextResponse.json({ error: "Realtime not configured" }, { status: 501 });
  }

  const session = await auth();
  const userId = session?.user?.id;
  const orgId = session?.user?.activeOrgId;
  if (!userId || !orgId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { socketId, channel } = await readBody(req);
  if (!socketId || !channel) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Tenant isolation: only sign channels that belong to the caller's own org.
  // Our channels always end with the orgId (private-org-<id> / presence-org-<id>).
  if (!channel.endsWith(`-org-${orgId}`)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve a display name for presence membership (best-effort).
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const name = user?.name || user?.email || "Member";

  const authResponse = await authorizeChannel(socketId, channel, { id: userId, info: { name } });
  if (!authResponse) {
    return NextResponse.json({ error: "Realtime not configured" }, { status: 501 });
  }
  return NextResponse.json(authResponse);
}
