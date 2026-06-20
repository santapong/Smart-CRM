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

import { notify, getUnreadCount, listNotifications } from "@/lib/notifications";
import { markNotificationRead, markAllRead, listMyNotifications } from "@/server/actions/notifications";
import { sendNotificationDigests } from "@/lib/notification-digest";

let orgA = "", orgB = "", userA = "", userB = "", noEmailUser = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `nfa${ts}@t.io`, name: "Notify A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `nfb${ts}@t.io`, name: "Notify B", passwordHash: pw } });
  // A user without an email is not possible (email is required + unique), so we
  // exercise the "no delivery" path by deleting the recipient before notifying.
  const ne = await db.user.create({ data: { email: `nfne${ts}@t.io`, name: "No Email", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `NfOrgA-${ts}`, slug: `nf-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `NfOrgB-${ts}`, slug: `nf-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id; noEmailUser = ne.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.notificationDelivery.deleteMany({ where: { notification: { orgId: { in: orgs } } } });
  await db.notification.deleteMany({ where: { orgId: { in: orgs } } });
  await db.emailMessage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB, noEmailUser] } } });
  await db.$disconnect();
});

describe("notify (M10)", () => {
  it("creates a Notification and an email delivery row when the recipient has an email", async () => {
    const res = await notify({
      orgId: orgA,
      recipientId: userA,
      type: "mention",
      title: "You were mentioned",
      body: "Take a look",
      entityType: "deal",
      entityId: "deal-1",
      actorId: userB,
    });
    const n = await db.notification.findUnique({ where: { id: res.id } });
    expect(n?.orgId).toBe(orgA);
    expect(n?.recipientId).toBe(userA);
    expect(n?.type).toBe("mention");
    expect(n?.readAt).toBeNull();

    const deliveries = await db.notificationDelivery.findMany({ where: { notificationId: res.id } });
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].channel).toBe("email");
    // No RESEND_API_KEY in CI → recorded but skipped (never throws).
    expect(deliveries[0].status).toBe("skipped");
  });

  it("creates a Notification without a delivery row when the recipient has no email", async () => {
    // Remove the user so the email lookup returns null (no delivery created).
    await db.user.delete({ where: { id: noEmailUser } });
    const res = await notify({
      orgId: orgA,
      recipientId: noEmailUser,
      type: "system",
      title: "Orphan notice",
    });
    const n = await db.notification.findUnique({ where: { id: res.id } });
    expect(n).not.toBeNull();
    const deliveries = await db.notificationDelivery.findMany({ where: { notificationId: res.id } });
    expect(deliveries.length).toBe(0);
  });
});

describe("getUnreadCount + listNotifications (M10)", () => {
  it("counts only unread for the right org + user and lists newest first", async () => {
    await notify({ orgId: orgA, recipientId: userA, type: "system", title: "One" });
    await notify({ orgId: orgA, recipientId: userA, type: "system", title: "Two" });
    // A notification for org B / user B must not leak into org A / user A.
    await notify({ orgId: orgB, recipientId: userB, type: "system", title: "Other org" });

    const count = await getUnreadCount(orgA, userA);
    expect(count).toBeGreaterThanOrEqual(3);

    const list = await listNotifications(orgA, userA, { limit: 50 });
    expect(list.every((n) => n.orgId === orgA && n.recipientId === userA)).toBe(true);
    // Newest first.
    expect(list[0].createdAt >= list[list.length - 1].createdAt).toBe(true);
  });
});

describe("mark read actions (M10)", () => {
  it("markNotificationRead marks a single one and only the owner can", async () => {
    const r = await notify({ orgId: orgA, recipientId: userA, type: "system", title: "Mark me" });

    // User B (different recipient) cannot mark user A's notification.
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const wrong = await markNotificationRead(r.id);
    expect(wrong.ok).toBe(false);

    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const ok = await markNotificationRead(r.id);
    expect(ok.ok).toBe(true);
    const n = await db.notification.findUnique({ where: { id: r.id } });
    expect(n?.readAt).not.toBeNull();
  });

  it("markAllRead clears every unread for the user and listMyNotifications reflects it", async () => {
    await notify({ orgId: orgA, recipientId: userA, type: "system", title: "Bulk 1" });
    await notify({ orgId: orgA, recipientId: userA, type: "system", title: "Bulk 2" });
    active = { userId: userA, orgId: orgA, role: "OWNER" };

    const before = await listMyNotifications(50);
    expect(before.unread).toBeGreaterThan(0);

    const res = await markAllRead();
    expect(res.ok).toBe(true);

    const after = await listMyNotifications(50);
    expect(after.unread).toBe(0);
    expect(await getUnreadCount(orgA, userA)).toBe(0);
  });
});

describe("notification digest (M10)", () => {
  it("sends one env-gated digest per user with unread notifications (no-op without key)", async () => {
    await notify({ orgId: orgA, recipientId: userA, type: "system", title: "Digest me" });
    const res = await sendNotificationDigests();
    expect(res.users).toBeGreaterThan(0);
    // With no RESEND_API_KEY, sends are recorded as skipped EmailMessages.
    const msgs = await db.emailMessage.count({ where: { orgId: orgA } });
    expect(msgs).toBeGreaterThan(0);
  });
});
