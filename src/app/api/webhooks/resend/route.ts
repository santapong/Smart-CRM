import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Resend webhook signing uses Svix headers. Until we integrate `svix` here,
// this endpoint is intentionally a no-op that refuses to mutate state — an
// unauthenticated handler that flipped MessageLog.status would be a forgeable
// status-mutation endpoint.
//
// TODO: install `svix`, verify `svix-id` / `svix-timestamp` / `svix-signature`
// using RESEND_WEBHOOK_SECRET, then map event types to MessageLog.status:
//   email.sent       -> SENT
//   email.delivered  -> DELIVERED
//   email.bounced    -> FAILED
//   email.complained -> FAILED
export async function POST() {
  return NextResponse.json(
    { error: "Resend webhook handler is not yet wired up." },
    { status: 503 },
  );
}
