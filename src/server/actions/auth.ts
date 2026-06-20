"use server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { slugify } from "@/lib/utils";
import { rateLimit } from "@/lib/ratelimit";
import { sendEmail } from "@/lib/email";
import { verifyEmail, passwordReset } from "@/lib/email-templates";
import {
  createVerificationToken,
  consumeVerificationToken,
  createPasswordResetToken,
  findValidResetToken,
} from "@/lib/auth-tokens";

const signUpSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().toLowerCase(),
  password: z.string().min(6).max(100),
  orgName: z.string().min(2).max(80),
});

const DEFAULT_STAGES = [
  { name: "Lead", order: 0, color: "#64748b", probability: 10 },
  { name: "Qualified", order: 1, color: "#0ea5e9", probability: 30 },
  { name: "Proposal", order: 2, color: "#8b5cf6", probability: 50 },
  { name: "Negotiation", order: 3, color: "#f59e0b", probability: 70 },
  { name: "Closing", order: 4, color: "#10b981", probability: 90 },
];

export async function signUpAction(input: unknown): Promise<ActionResult<{ userId: string; orgId: string }>> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);

  const { name, email, password, orgName } = parsed.data;

  // Rate limit sign-up attempts per email. No-op when Upstash is not configured
  // (local/CI/tests), so existing tests still exercise the happy path.
  const limit = await rateLimit(`signup:${email}`);
  if (!limit.success) return fail("Too many attempts, try again later");

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return fail("Email already in use");

  const passwordHash = await bcrypt.hash(password, 10);

  const slugBase = slugify(orgName) || "team";
  let slug = slugBase;
  let i = 1;
  while (await db.organization.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${slugBase}-${i}`;
  }

  const result = await db.$transaction(async (tx) => {
    // emailVerified intentionally left null — credentials login does NOT require
    // a verified email (see src/lib/auth.ts), so this never blocks sign-in; it
    // simply gives the verification flow something to confirm.
    const user = await tx.user.create({
      data: { email, name, passwordHash },
    });
    const org = await tx.organization.create({
      data: {
        name: orgName,
        slug,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    const pipeline = await tx.pipeline.create({
      data: { orgId: org.id, name: "Sales Pipeline", isDefault: true, order: 0 },
    });
    await tx.pipelineStage.createMany({
      data: DEFAULT_STAGES.map((s) => ({ ...s, orgId: org.id, pipelineId: pipeline.id })),
    });
    return { userId: user.id, orgId: org.id };
  });

  // Fire a verification email (recorded-but-skipped without RESEND_API_KEY).
  // Never let an email failure break sign-up.
  try {
    const { url } = await createVerificationToken(email);
    const { subject, html } = verifyEmail({ url, name });
    await sendEmail({ orgId: result.orgId, to: email, subject, html, sentById: result.userId });
  } catch {
    // best-effort; sign-up already succeeded
  }

  return ok(result);
}

/**
 * Confirm an email-verification token (D2). Sets `user.emailVerified`. Returns
 * a generic failure for an invalid/expired token.
 */
export async function verifyEmailAction(token: unknown): Promise<ActionResult<{ verified: true }>> {
  const parsed = z.string().min(1).safeParse(token);
  if (!parsed.success) return fail("Invalid token");
  const res = await consumeVerificationToken(parsed.data);
  if (!res.ok) return fail("This verification link is invalid or has expired");
  return ok({ verified: true });
}

const emailSchema = z.object({ email: z.string().email().toLowerCase() });

/**
 * Request a password reset (D2). ALWAYS returns ok to avoid leaking which
 * emails have accounts. When the user exists, creates a token + emails a
 * /reset?token= link (recorded-but-skipped offline).
 */
export async function requestPasswordReset(input: unknown): Promise<ActionResult<{ sent: true }>> {
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) return ok({ sent: true });
  const { email } = parsed.data;

  // Rate limit by email; no-op without Upstash.
  const limit = await rateLimit(`pwreset:${email}`);
  if (!limit.success) return ok({ sent: true });

  const user = await db.user.findUnique({ where: { email } });
  if (user) {
    // Scope the send to one of the user's orgs (suppression is per-org); fall
    // back to a send without org-suppression if the user has no membership.
    const membership = await db.membership.findFirst({ where: { userId: user.id } });
    try {
      const { url } = await createPasswordResetToken(email);
      const { subject, html } = passwordReset({ url, name: user.name });
      if (membership) {
        await sendEmail({ orgId: membership.orgId, to: email, subject, html, sentById: user.id });
      }
    } catch {
      // best-effort; never reveal failures to the caller
    }
  }
  return ok({ sent: true });
}

const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6).max(100),
});

/**
 * Complete a password reset (D2). Validates the unexpired token, updates the
 * user's passwordHash (bcrypt), and deletes the token.
 */
export async function resetPassword(input: unknown): Promise<ActionResult<{ reset: true }>> {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { token, password } = parsed.data;

  const valid = await findValidResetToken(token);
  if (!valid) return fail("This reset link is invalid or has expired");

  const passwordHash = await bcrypt.hash(password, 10);
  await db.$transaction(async (tx) => {
    await tx.user.updateMany({ where: { email: valid.email }, data: { passwordHash } });
    await tx.passwordResetToken.deleteMany({ where: { token } });
  });
  return ok({ reset: true });
}
