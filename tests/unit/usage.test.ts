import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { getUsage } from "@/lib/usage";
import { sendEmail } from "@/lib/email";

let orgId = "";
let userId = "";

const row = (rows: Awaited<ReturnType<typeof getUsage>>["rows"], key: string) =>
  rows.find((r) => r.key === key)!;

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `usage${ts}@t.io`, name: "Use", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `UsageOrg-${ts}`, slug: `usage-org-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id;
  userId = u.id;
});

afterAll(async () => {
  await db.campaignRecipient.deleteMany({ where: { orgId } });
  await db.campaign.deleteMany({ where: { orgId } });
  await db.emailMessage.deleteMany({ where: { orgId } });
  await db.lead.deleteMany({ where: { orgId } });
  await db.pipeline.deleteMany({ where: { orgId } });
  await db.entitlement.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("usage metering (M19b)", () => {
  it("reports the free plan and a row per metered resource", async () => {
    const usage = await getUsage(orgId);
    expect(usage.plan.key).toBe("free");
    // A row for every counter, each with a label.
    expect(usage.rows.length).toBeGreaterThanOrEqual(14);
    expect(usage.rows.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);

    // The owner membership counts as one seat; free allows 3 → not over/near.
    const seats = row(usage.rows, "seats");
    expect(seats.used).toBe(1);
    expect(seats.limit).toBe(3);
    expect(seats.unlimited).toBe(false);
    expect(seats.over).toBe(false);
  });

  it("flags a resource as over once it reaches its limit (incl. a 0 limit)", async () => {
    // Free allows exactly 1 pipeline; create it → used == limit → over.
    await db.pipeline.create({ data: { orgId, name: "P1", order: 0 } });
    const usage = await getUsage(orgId);
    const pipelines = row(usage.rows, "pipelines");
    expect(pipelines.used).toBe(1);
    expect(pipelines.limit).toBe(1);
    expect(pipelines.over).toBe(true);

    // Free allows 0 custom fields → 0 used is already "over" (can't add any).
    const customFields = row(usage.rows, "customFields");
    expect(customFields.limit).toBe(0);
    expect(customFields.over).toBe(true);
  });

  it("flags a resource as near at >=80% of its limit", async () => {
    // Override the leads limit to 5, then create 4 → 80% → near (not over).
    await db.entitlement.create({ data: { orgId, key: "leads", intValue: 5 } });
    await db.lead.createMany({
      data: [0, 1, 2, 3].map((i) => ({ orgId, title: `Lead ${i}` })),
    });
    const usage = await getUsage(orgId);
    const leads = row(usage.rows, "leads");
    expect(leads.used).toBe(4);
    expect(leads.limit).toBe(5);
    expect(leads.near).toBe(true);
    expect(leads.over).toBe(false);
  });

  it("treats an unlimited (-1) override as never near/over", async () => {
    await db.entitlement.create({ data: { orgId, key: "campaigns", intValue: -1 } });
    await db.campaign.createMany({
      data: [0, 1].map((i) => ({ orgId, name: `C${i}`, subject: "S", bodyHtml: "<p>x</p>", status: "DRAFT" as const })),
    });
    const usage = await getUsage(orgId);
    const campaigns = row(usage.rows, "campaigns");
    expect(campaigns.used).toBe(2);
    expect(campaigns.unlimited).toBe(true);
    expect(campaigns.over).toBe(false);
    expect(campaigns.near).toBe(false);
  });

  it("counts emails recorded this month", async () => {
    const before = (await getUsage(orgId)).emailsThisMonth;
    await sendEmail({ orgId, to: "someone@example.com", subject: "Hi", html: "<p>hi</p>" });
    const after = (await getUsage(orgId)).emailsThisMonth;
    expect(after).toBe(before + 1);
  });
});
