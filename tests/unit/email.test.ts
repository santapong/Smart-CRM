import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

let active: { userId: string; orgId: string; role: "OWNER" | "ADMIN" | "MEMBER" } | null = null;
vi.mock("@/lib/tenant", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tenant")>("@/lib/tenant");
  return {
    ...actual,
    requireOrg: async () => {
      if (!active) throw new Error("No active org for test");
      return active;
    },
  };
});

import { sendEmail, getResend } from "@/lib/email";
import { sendTrackedEmail } from "@/server/actions/email";
import {
  signUpAction,
  verifyEmailAction,
  requestPasswordReset,
  resetPassword,
} from "@/server/actions/auth";

let orgId = "";
let userId = "";
let contactWithEmail = "";
let contactNoEmail = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `em${ts}@t.io`, name: "Em", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `EmOrg-${ts}`, slug: `em-org-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id;
  userId = u.id;
  const c1 = await db.contact.create({
    data: { orgId, firstName: "Has", lastName: "Email", email: `recipient${ts}@t.io` },
  });
  const c2 = await db.contact.create({
    data: { orgId, firstName: "No", lastName: "Email" },
  });
  contactWithEmail = c1.id;
  contactNoEmail = c2.id;
});

afterAll(async () => {
  await db.emailEvent.deleteMany({ where: { emailMessage: { orgId } } });
  await db.emailMessage.deleteMany({ where: { orgId } });
  await db.suppression.deleteMany({ where: { orgId } });
  await db.outboxEvent.deleteMany({ where: { orgId } });
  await db.contact.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  // Clean up any users/orgs created by the sign-up + reset round-trip tests.
  await db.$disconnect();
});

describe("email infrastructure is env-gated (M7)", () => {
  it("getResend() returns null without RESEND_API_KEY", () => {
    expect(process.env.RESEND_API_KEY).toBeFalsy();
    expect(getResend()).toBeNull();
  });

  it("sendEmail records a skipped message with no API key (never throws)", async () => {
    const res = await sendEmail({
      orgId,
      to: "nobody@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });
    expect(res.status).toBe("skipped");
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("no_api_key");
    const msg = await db.emailMessage.findUnique({ where: { id: res.id } });
    expect(msg?.status).toBe("skipped");
    expect(msg?.providerMessageId).toBeNull();
    expect(msg?.toAddr).toBe("nobody@example.com");
  });

  it("a suppression blocks a send (recorded as skipped/suppressed)", async () => {
    await db.suppression.create({ data: { orgId, email: "blocked@example.com", reason: "bounced" } });
    const res = await sendEmail({
      orgId,
      to: "blocked@example.com",
      subject: "Should skip",
      html: "<p>x</p>",
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("suppressed");
  });
});

describe("sendTrackedEmail (M7)", () => {
  it("resolves the contact email, records a message, and emits email.sent", async () => {
    active = { userId, orgId, role: "OWNER" };
    const res = await sendTrackedEmail({ contactId: contactWithEmail, subject: "Hi", body: "Body here" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const msg = await db.emailMessage.findUnique({ where: { id: res.data.id } });
      expect(msg?.contactId).toBe(contactWithEmail);
      expect(msg?.status).toBe("skipped"); // no API key → skipped, but recorded
    }
    const events = await db.outboxEvent.count({ where: { orgId, name: "email.sent" } });
    expect(events).toBeGreaterThan(0);
  });

  it("fails cleanly when the record has no email address", async () => {
    active = { userId, orgId, role: "OWNER" };
    const res = await sendTrackedEmail({ contactId: contactNoEmail, subject: "Hi", body: "x" });
    expect(res.ok).toBe(false);
  });

  it("requires a contactId or dealId", async () => {
    active = { userId, orgId, role: "OWNER" };
    const res = await sendTrackedEmail({ subject: "Hi", body: "x" });
    expect(res.ok).toBe(false);
  });
});

describe("auth emails: verification (D2)", () => {
  it("signUpAction creates an unverified user and verifyEmailAction sets emailVerified", async () => {
    const ts = Date.now();
    const email = `verify${ts}@t.io`;
    const res = await signUpAction({
      name: "Verify Me",
      email,
      password: "password123",
      orgName: `Verify Org ${ts}`,
    });
    expect(res.ok).toBe(true);

    const before = await db.user.findUnique({ where: { email } });
    expect(before?.emailVerified).toBeNull();

    // A VerificationToken was created by sign-up.
    const tok = await db.verificationToken.findFirst({ where: { identifier: email } });
    expect(tok).not.toBeNull();

    const verify = await verifyEmailAction(tok!.token);
    expect(verify.ok).toBe(true);

    const after = await db.user.findUnique({ where: { email } });
    expect(after?.emailVerified).not.toBeNull();

    // Token is single-use → reusing it fails.
    const again = await verifyEmailAction(tok!.token);
    expect(again.ok).toBe(false);

    // Cleanup
    if (before) {
      await db.outboxEvent.deleteMany({ where: { orgId: (res as { data: { orgId: string } }).data.orgId } });
      await db.emailMessage.deleteMany({ where: { orgId: (res as { data: { orgId: string } }).data.orgId } });
      await db.pipelineStage.deleteMany({ where: { orgId: (res as { data: { orgId: string } }).data.orgId } });
      await db.pipeline.deleteMany({ where: { orgId: (res as { data: { orgId: string } }).data.orgId } });
      await db.membership.deleteMany({ where: { orgId: (res as { data: { orgId: string } }).data.orgId } });
      await db.organization.deleteMany({ where: { id: (res as { data: { orgId: string } }).data.orgId } });
      await db.user.deleteMany({ where: { email } });
    }
  });

  it("verifyEmailAction rejects an invalid token", async () => {
    const res = await verifyEmailAction("not-a-real-token");
    expect(res.ok).toBe(false);
  });
});

describe("auth emails: password reset round-trip (D2)", () => {
  it("request → reset → can verify the new hash; old hash no longer matches", async () => {
    const ts = Date.now();
    const email = `reset${ts}@t.io`;
    const oldHash = await bcrypt.hash("oldpassword", 4);
    const u = await db.user.create({
      data: {
        email,
        name: "Reset User",
        passwordHash: oldHash,
        memberships: undefined,
      },
    });
    const o = await db.organization.create({
      data: { name: `ResetOrg-${ts}`, slug: `reset-org-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
    });

    // Request always returns ok (no user enumeration).
    const req = await requestPasswordReset({ email });
    expect(req.ok).toBe(true);
    // Unknown email also returns ok.
    const reqUnknown = await requestPasswordReset({ email: `missing${ts}@t.io` });
    expect(reqUnknown.ok).toBe(true);

    const tok = await db.passwordResetToken.findFirst({ where: { email } });
    expect(tok).not.toBeNull();

    const newPassword = "brandnewpass1";
    const reset = await resetPassword({ token: tok!.token, password: newPassword });
    expect(reset.ok).toBe(true);

    const after = await db.user.findUnique({ where: { email } });
    expect(after?.passwordHash).toBeTruthy();
    expect(await bcrypt.compare(newPassword, after!.passwordHash!)).toBe(true);
    expect(await bcrypt.compare("oldpassword", after!.passwordHash!)).toBe(false);

    // Token consumed → reuse fails.
    const reuse = await resetPassword({ token: tok!.token, password: "anotherpass1" });
    expect(reuse.ok).toBe(false);

    // Cleanup
    await db.emailMessage.deleteMany({ where: { orgId: o.id } });
    await db.passwordResetToken.deleteMany({ where: { email } });
    await db.membership.deleteMany({ where: { orgId: o.id } });
    await db.organization.deleteMany({ where: { id: o.id } });
    await db.user.deleteMany({ where: { email } });
  });

  it("resetPassword rejects an invalid/expired token", async () => {
    const res = await resetPassword({ token: "nope", password: "whatever1" });
    expect(res.ok).toBe(false);
  });
});
