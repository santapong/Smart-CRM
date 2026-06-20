import { NextResponse } from "next/server";
import { ssoConfigured, SSO_NOT_CONFIGURED_REASON } from "@/lib/sso";

/**
 * SSO (SAML) entry/ACS endpoint (M16 scaffold). Env-gated: until JACKSON_* is
 * configured this returns 501 Not Implemented. The real SAML auth flow (SP
 * redirect + ACS callback) runs through BoxyHQ Jackson, which we deliberately do
 * NOT install here (it needs its own datastore). When configured, this would
 * delegate the SAML handshake to Jackson and then mint a NextAuth session.
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
