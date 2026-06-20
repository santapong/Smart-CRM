import { NextResponse } from "next/server";
import { ssoConfigured, SSO_NOT_CONFIGURED_REASON } from "@/lib/sso";

/**
 * SCIM v2 endpoint (M16 scaffold). Env-gated: until JACKSON_* is configured this
 * returns 501 Not Implemented. The real directory-sync flow runs through BoxyHQ
 * Jackson, which we deliberately do NOT install here (it needs its own
 * datastore). When configured, this would proxy to Jackson's SCIM controller.
 *
 * TODO: wire BoxyHQ Jackson when JACKSON_* env is provided.
 */

export const runtime = "nodejs";

function notImplemented(): Response {
  return NextResponse.json(
    { error: "SSO/SCIM not configured", detail: SSO_NOT_CONFIGURED_REASON },
    { status: 501 },
  );
}

function handler(): Response {
  if (!ssoConfigured()) return notImplemented();
  // TODO: wire BoxyHQ Jackson when JACKSON_* env is provided.
  return notImplemented();
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
