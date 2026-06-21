import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";

/**
 * Auth token helpers (M7 / D2). Used for email verification and password reset.
 * All link bases reuse AUTH_URL (falling back to localhost) so we never depend
 * on a separate config var.
 */

const VERIFY_TTL_MS = 1000 * 60 * 60 * 24; // 24h
const RESET_TTL_MS = 1000 * 60 * 60; // 1h

/** Base URL for emailed links — AUTH_URL, else localhost. */
export function appUrl(): string {
  return (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Create an email-verification token (NextAuth `VerificationToken`). The
 * identifier is the email; returns the absolute /verify link.
 */
export async function createVerificationToken(email: string): Promise<{ token: string; url: string }> {
  const token = newToken();
  await db.verificationToken.create({
    data: { identifier: email.toLowerCase(), token, expires: new Date(Date.now() + VERIFY_TTL_MS) },
  });
  return { token, url: `${appUrl()}/verify?token=${token}` };
}

/**
 * Consume a verification token: if valid + unexpired, mark the user verified.
 * Idempotent-ish — a missing/expired token returns false.
 */
export async function consumeVerificationToken(token: string): Promise<{ ok: boolean; email?: string }> {
  const row = await db.verificationToken.findUnique({ where: { token } });
  if (!row) return { ok: false };
  // Always delete the token (single-use), even if expired.
  await db.verificationToken.deleteMany({ where: { token } });
  if (row.expires < new Date()) return { ok: false };
  await db.user.updateMany({
    where: { email: row.identifier },
    data: { emailVerified: new Date() },
  });
  return { ok: true, email: row.identifier };
}

/** Create a password-reset token and return the absolute /reset link. */
export async function createPasswordResetToken(email: string): Promise<{ token: string; url: string }> {
  const token = newToken();
  await db.passwordResetToken.create({
    data: { email: email.toLowerCase(), token, expires: new Date(Date.now() + RESET_TTL_MS) },
  });
  return { token, url: `${appUrl()}/reset?token=${token}` };
}

/** Look up a password-reset token, returning the email when valid + unexpired. */
export async function findValidResetToken(token: string): Promise<{ email: string } | null> {
  const row = await db.passwordResetToken.findUnique({ where: { token } });
  if (!row || row.expires < new Date()) return null;
  return { email: row.email };
}
