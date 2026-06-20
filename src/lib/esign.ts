/**
 * eSignature scaffold (M18) — fully env-gated, no heavy deps.
 *
 * Like the SSO/SCIM scaffold (M16), the real provider flow (Dropbox Sign,
 * DocuSign, …) would run through a vendor SDK that we deliberately DO NOT install
 * here, so the build/tests stay green with zero extra infra and no keys. Instead:
 *  - {@link esignConfigured} reports whether the provider env wiring is present.
 *  - {@link requestSignature} returns a clear "eSign not configured" result (and
 *    makes no network call) until it is.
 *  - The /api/esign/webhook route returns 501 until configured.
 *
 * TODO: wire Dropbox Sign (formerly HelloSign) when DROPBOX_SIGN_API_KEY is set.
 */

/** Default provider key recorded on SignatureRequest rows. */
export const ESIGN_PROVIDER = "dropbox_sign" as const;

/** Shared "eSign is not configured" sentinel returned where a key is absent. */
export const ESIGN_NOT_CONFIGURED = "eSign is not configured" as const;

/** Human-readable hint shown in the UI when eSign is not configured. */
export const ESIGN_NOT_CONFIGURED_REASON =
  "Set DROPBOX_SIGN_API_KEY to enable sending documents for signature." as const;

/** True when the eSign provider (Dropbox Sign) is wired up. */
export function esignConfigured(): boolean {
  return Boolean(process.env.DROPBOX_SIGN_API_KEY);
}

/** A single signer on a request. */
export type Signer = { email: string; name?: string };

export type RequestSignatureInput = {
  /** Title shown to signers (typically the Document title). */
  title: string;
  /** The rendered document content to be signed. */
  content: string;
  signers: Signer[];
};

export type RequestSignatureResult =
  | { ok: true; externalId: string }
  | { ok: false; error: typeof ESIGN_NOT_CONFIGURED | string };

/**
 * Send a document for signature via the provider. Returns the provider's request
 * id on success. When eSign is unconfigured it returns a graceful not-configured
 * result and makes NO network call — never throws for the offline case (mirrors
 * complete() in src/lib/ai.ts).
 */
export async function requestSignature(
  input: RequestSignatureInput,
): Promise<RequestSignatureResult> {
  if (!esignConfigured()) return { ok: false, error: ESIGN_NOT_CONFIGURED };
  if (input.signers.length === 0) return { ok: false, error: "At least one signer is required" };

  // TODO: wire Dropbox Sign — construct the SDK client from
  // DROPBOX_SIGN_API_KEY, create a signature request from `input.content` +
  // `input.signers`, and return the provider's request id below.
  return { ok: false, error: ESIGN_NOT_CONFIGURED };
}
