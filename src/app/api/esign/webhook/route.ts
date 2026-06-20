import { NextResponse } from "next/server";
import { esignConfigured, ESIGN_NOT_CONFIGURED_REASON } from "@/lib/esign";

/**
 * eSign provider status callback (M18 scaffold). Env-gated: until
 * DROPBOX_SIGN_API_KEY is set this returns 501 Not Implemented. The provider SDK
 * is deliberately NOT installed here (mirrors the M16 SSO scaffold). When
 * configured, this would verify the provider signature and update the matching
 * SignatureRequest.status (and the linked Document.status when fully signed).
 *
 * TODO: wire Dropbox Sign — verify the callback signature and update
 * SignatureRequest.status (PENDING → SENT → SIGNED / DECLINED).
 */

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
  if (!esignConfigured()) {
    return NextResponse.json(
      { error: "eSign not configured", detail: ESIGN_NOT_CONFIGURED_REASON },
      { status: 501 },
    );
  }
  // TODO: wire Dropbox Sign — verify signature, map the provider event to a
  // SignatureRequest, and update its status.
  return NextResponse.json({ ok: true });
}
