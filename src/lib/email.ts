import { Resend } from "resend";
import { db } from "@/lib/db";

/**
 * Email infrastructure (M7). Fully env-gated: with no RESEND_API_KEY the app
 * still builds and runs — sends are *recorded but skipped* (status "skipped")
 * and never throw. {@link sendEmail} always returns a result.
 */

let cached: Resend | null | undefined;

/** Lazily-constructed Resend client. Returns null when RESEND_API_KEY is unset. */
export function getResend(): Resend | null {
  if (cached !== undefined) return cached;
  const key = process.env.RESEND_API_KEY;
  cached = key ? new Resend(key) : null;
  return cached;
}

/** Resolve the From address: explicit override → EMAIL_FROM → safe default. */
function resolveFrom(from?: string): string {
  return from ?? process.env.EMAIL_FROM ?? "no-reply@example.com";
}

export type SendEmailInput = {
  orgId: string;
  to: string;
  subject: string;
  html: string;
  from?: string;
  contactId?: string | null;
  dealId?: string | null;
  sentById?: string | null;
};

export type SendEmailResult = {
  id: string;
  status: "sent" | "skipped" | "failed";
  providerMessageId: string | null;
  skipped: boolean;
  reason?: "no_api_key" | "suppressed" | "provider_error";
};

/**
 * Send (or record-and-skip) a single outbound email.
 *
 * - Skips + records `status:"skipped"` when the address is suppressed for the
 *   org, or when no RESEND_API_KEY is configured (in dev we console.log the
 *   intended email so links are recoverable).
 * - Otherwise sends via Resend, recording `status:"sent"` with the provider id.
 * - On a provider error, records `status:"failed"` and returns — never throws.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const { orgId, to, subject, html } = input;
  const fromAddr = resolveFrom(input.from);

  const base = {
    orgId,
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    direction: "outbound",
    subject,
    body: html,
    fromAddr,
    toAddr: to,
    sentById: input.sentById ?? null,
  };

  // 1) Suppressed recipients are recorded but never sent.
  const suppressed = await db.suppression.findUnique({
    where: { orgId_email: { orgId, email: to.toLowerCase() } },
  });
  if (suppressed) {
    const msg = await db.emailMessage.create({ data: { ...base, status: "skipped" } });
    return { id: msg.id, status: "skipped", providerMessageId: null, skipped: true, reason: "suppressed" };
  }

  // 2) No provider configured → record a skipped placeholder (never throw).
  const resend = getResend();
  if (!resend) {
    if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.log(`[email:skipped] no RESEND_API_KEY — would send to ${to}: "${subject}"\n${html}`);
    }
    const msg = await db.emailMessage.create({ data: { ...base, status: "skipped" } });
    return { id: msg.id, status: "skipped", providerMessageId: null, skipped: true, reason: "no_api_key" };
  }

  // 3) Real send.
  try {
    const res = await resend.emails.send({ from: fromAddr, to, subject, html });
    if (res.error) {
      const msg = await db.emailMessage.create({ data: { ...base, status: "failed" } });
      return { id: msg.id, status: "failed", providerMessageId: null, skipped: false, reason: "provider_error" };
    }
    const msg = await db.emailMessage.create({
      data: { ...base, status: "sent", providerMessageId: res.data?.id ?? null },
    });
    return { id: msg.id, status: "sent", providerMessageId: res.data?.id ?? null, skipped: false };
  } catch {
    const msg = await db.emailMessage.create({ data: { ...base, status: "failed" } });
    return { id: msg.id, status: "failed", providerMessageId: null, skipped: false, reason: "provider_error" };
  }
}
