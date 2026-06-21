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

import { resolveAudience, materializeRecipients, runCampaignSend, campaignStats } from "@/lib/campaigns";
import { createCampaign, deleteCampaign, sendCampaign } from "@/server/actions/campaigns";

let orgA = "", orgB = "", userA = "", userB = "";
let tagId = "", companyId = "", dupEmail = "", twoEmail = "", blockedEmail = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  dupEmail = `dup${ts}@t.io`;
  twoEmail = `two${ts}@t.io`;
  blockedEmail = `blocked${ts}@t.io`;

  const ua = await db.user.create({ data: { email: `cmpa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `cmpb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `CmpOrgA-${ts}`, slug: `cmp-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `CmpOrgB-${ts}`, slug: `cmp-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;

  // orgA: unlimited campaigns so the suite can create several via the action.
  await db.entitlement.create({ data: { orgId: orgA, key: "campaigns", intValue: -1 } });
  // orgB intentionally left on the free plan (campaigns limit 1) for the gate test.

  const company = await db.company.create({ data: { orgId: orgA, name: "Globex" } });
  companyId = company.id;
  const tag = await db.tag.create({ data: { orgId: orgA, name: "VIP", color: "#ef4444" } });
  tagId = tag.id;

  const c1 = await db.contact.create({ data: { orgId: orgA, firstName: "Dup", lastName: "One", email: dupEmail } });
  // Same email on a second contact → must dedupe to one recipient.
  await db.contact.create({ data: { orgId: orgA, firstName: "Dup", lastName: "Two", email: dupEmail } });
  await db.contact.create({ data: { orgId: orgA, firstName: "At", lastName: "Globex", email: twoEmail, companyId } });
  await db.contact.create({ data: { orgId: orgA, firstName: "No", lastName: "Email" } });
  await db.contact.create({ data: { orgId: orgA, firstName: "Blocked", lastName: "Addr", email: blockedEmail } });
  // c1 carries the VIP tag.
  await db.contactTag.create({ data: { contactId: c1.id, tagId } });
  // blockedEmail is on the org's suppression list → excluded from every audience.
  await db.suppression.create({ data: { orgId: orgA, email: blockedEmail, reason: "bounced" } });

  await db.contact.create({ data: { orgId: orgB, firstName: "Other", lastName: "Org", email: `other${ts}@t.io` } });
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.campaignRecipient.deleteMany({ where: { orgId: { in: orgs } } });
  await db.campaign.deleteMany({ where: { orgId: { in: orgs } } });
  await db.emailMessage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.suppression.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contactTag.deleteMany({ where: { contact: { orgId: { in: orgs } } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.tag.deleteMany({ where: { orgId: { in: orgs } } });
  await db.company.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("audience resolution (M19b)", () => {
  it("resolves all contacts, deduping emails and excluding suppressed + no-email", async () => {
    const audience = await resolveAudience(orgA, { type: "all" });
    const emails = audience.map((a) => a.email).sort();
    expect(emails).toEqual([dupEmail, twoEmail].sort()); // dup collapsed, blocked + no-email gone
  });

  it("filters by tag", async () => {
    const audience = await resolveAudience(orgA, { type: "tag", tagId });
    expect(audience.map((a) => a.email)).toEqual([dupEmail]);
  });

  it("filters by company", async () => {
    const audience = await resolveAudience(orgA, { type: "company", companyId });
    expect(audience.map((a) => a.email)).toEqual([twoEmail]);
  });
});

describe("campaign send (M19b)", () => {
  it("creates → materializes recipients → sends offline (recorded, skipped) → stats", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const c = await createCampaign({ name: "Launch", subject: "Hello", bodyHtml: "<p>Hi</p>", audience: { type: "all" } });
    expect(c.ok).toBe(true);
    const campaignId = id(c);

    const created = await materializeRecipients(orgA, campaignId);
    expect(created).toBe(2);
    // Idempotent: re-materializing creates no duplicates.
    expect(await materializeRecipients(orgA, campaignId)).toBe(0);

    const result = await runCampaignSend(orgA, campaignId);
    // No RESEND_API_KEY → every send is recorded but skipped.
    expect(result.skipped).toBe(2);
    expect(result.sent).toBe(0);

    const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
    expect(campaign?.status).toBe("SENT");
    expect(campaign?.sentAt).not.toBeNull();

    const recipients = await db.campaignRecipient.findMany({ where: { campaignId } });
    expect(recipients).toHaveLength(2);
    expect(recipients.every((r) => r.status === "SKIPPED" && r.emailMessageId)).toBe(true);
    // One EmailMessage recorded per recipient.
    const msgs = await db.emailMessage.count({ where: { orgId: orgA, id: { in: recipients.map((r) => r.emailMessageId!) } } });
    expect(msgs).toBe(2);

    const stats = await campaignStats(orgA, campaignId);
    expect(stats.total).toBe(2);
    expect(stats.skipped).toBe(2);

    // Opens/clicks flow from the EmailMessage counters the Resend webhook bumps.
    await db.emailMessage.update({ where: { id: recipients[0].emailMessageId! }, data: { openCount: 3, clickCount: 1 } });
    const stats2 = await campaignStats(orgA, campaignId);
    expect(stats2.opens).toBe(3);
    expect(stats2.clicks).toBe(1);
  });

  it("sendCampaign fails when no recipient matches the audience", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    // A company with no contacts → empty audience.
    const empty = await db.company.create({ data: { orgId: orgA, name: "Empty Co" } });
    const c = await createCampaign({
      name: "Nobody",
      subject: "x",
      bodyHtml: "<p>x</p>",
      audience: { type: "company", companyId: empty.id },
    });
    const res = await sendCampaign(id(c));
    expect(res.ok).toBe(false);
  });
});

describe("plan gating & RBAC (M19b)", () => {
  it("enforces the free-plan campaigns limit", async () => {
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const first = await createCampaign({ name: "B1", subject: "s", bodyHtml: "<p>1</p>" });
    expect(first.ok).toBe(true);
    const second = await createCampaign({ name: "B2", subject: "s", bodyHtml: "<p>2</p>" });
    expect(second.ok).toBe(false); // free allows only 1
  });

  it("forbids non-admins from creating campaigns", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const res = await createCampaign({ name: "Nope", subject: "s", bodyHtml: "<p>x</p>" });
    expect(res.ok).toBe(false);
  });
});

describe("cross-org isolation (M19b)", () => {
  it("org B cannot send or delete org A's campaign", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const c = await createCampaign({ name: "A private", subject: "s", bodyHtml: "<p>x</p>" });
    const campaignId = id(c);

    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    expect((await sendCampaign(campaignId)).ok).toBe(false);
    expect((await deleteCampaign(campaignId)).ok).toBe(false);

    const row = await db.campaign.findUnique({ where: { id: campaignId } });
    expect(row?.orgId).toBe(orgA);
  });
});
