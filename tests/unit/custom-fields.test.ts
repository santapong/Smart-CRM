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

import {
  createFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
} from "@/server/actions/custom-fields";
import { createContact, updateContact } from "@/server/actions/contacts";
import { createCompany, updateCompany } from "@/server/actions/companies";
import { createDeal, updateDeal } from "@/server/actions/deals";
import { createPipeline, createStage } from "@/server/actions/pipelines";
import { createSavedView } from "@/server/actions/saved-views";

let orgA = "", orgB = "", userA = "", userB = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `cfa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `cfb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `CfOrgA-${ts}`, slug: `cf-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `CfOrgB-${ts}`, slug: `cf-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  // M4: the free plan caps customFields at 0 and pipelines at 1; lift both for
  // these orgs so the round-trip suites can define fields and create the
  // pipelines/stages the deal tests need. Over-limit behaviour is covered by a
  // dedicated suite below that sets its own org + override.
  await db.entitlement.createMany({
    data: [
      { orgId: orgA, key: "customFields", intValue: -1 },
      { orgId: orgA, key: "pipelines", intValue: -1 },
      { orgId: orgB, key: "customFields", intValue: -1 },
    ],
  });
});

afterAll(async () => {
  const orgs = { in: [orgA, orgB] };
  await db.outboxEvent.deleteMany({ where: { orgId: orgs } });
  await db.dealStageEvent.deleteMany({ where: { orgId: orgs } });
  await db.deal.deleteMany({ where: { orgId: orgs } });
  await db.pipelineStage.deleteMany({ where: { orgId: orgs } });
  await db.pipeline.deleteMany({ where: { orgId: orgs } });
  await db.savedView.deleteMany({ where: { orgId: orgs } });
  await db.contact.deleteMany({ where: { orgId: orgs } });
  await db.company.deleteMany({ where: { orgId: orgs } });
  await db.customFieldDefinition.deleteMany({ where: { orgId: orgs } });
  await db.entitlement.deleteMany({ where: { orgId: orgs } });
  await db.subscription.deleteMany({ where: { orgId: orgs } });
  await db.membership.deleteMany({ where: { orgId: orgs } });
  await db.organization.deleteMany({ where: { id: orgs } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("custom fields engine (M3)", () => {
  it("requires ADMIN to define a field", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    await expect(
      createFieldDefinition({ entity: "contact", key: "nope", label: "Nope", type: "text" }),
    ).rejects.toThrow();
  });

  it("defines a field, sets it on a contact via createContact, reads it back", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const def = await createFieldDefinition({
      entity: "contact",
      key: "linkedin",
      label: "LinkedIn",
      type: "text",
    });
    expect(def.ok).toBe(true);

    const c = await createContact({
      firstName: "Cust",
      lastName: "Field",
      customFields: { linkedin: "in/cust", ignored: "drop-me" },
    });
    expect(c.ok).toBe(true);
    const saved = await db.contact.findUnique({ where: { id: id(c) } });
    expect(saved?.customFields).toEqual({ linkedin: "in/cust" });
  });

  it("rejects a missing required field", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const def = await createFieldDefinition({
      entity: "contact",
      key: "ssn_last4",
      label: "SSN last4",
      type: "text",
      required: true,
    });
    expect(def.ok).toBe(true);

    const bad = await createContact({ firstName: "No", lastName: "Required", customFields: {} });
    expect(bad.ok).toBe(false);

    const good = await createContact({
      firstName: "Has",
      lastName: "Required",
      customFields: { ssn_last4: "1234" },
    });
    expect(good.ok).toBe(true);

    // Clean up the required field so later tests aren't forced to set it.
    await deleteFieldDefinition(id(def));
  });

  it("coerces number/boolean and validates select options", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const seats = await createFieldDefinition({
      entity: "contact",
      key: "seats",
      label: "Seats",
      type: "number",
    });
    const tier = await createFieldDefinition({
      entity: "contact",
      key: "tier",
      label: "Tier",
      type: "select",
      config: { options: ["gold", "silver"] },
    });
    expect(seats.ok && tier.ok).toBe(true);

    const okRes = await createContact({
      firstName: "Sel",
      lastName: "Ect",
      customFields: { seats: "5", tier: "gold" },
    });
    expect(okRes.ok).toBe(true);
    const saved = await db.contact.findUnique({ where: { id: id(okRes) } });
    expect(saved?.customFields).toEqual({ seats: 5, tier: "gold" });

    const badSelect = await createContact({
      firstName: "Bad",
      lastName: "Sel",
      customFields: { tier: "bronze" },
    });
    expect(badSelect.ok).toBe(false);
  });

  it("rejects a select definition with no options", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const bad = await createFieldDefinition({
      entity: "contact",
      key: "broken_select",
      label: "Broken",
      type: "select",
      config: { options: [] },
    });
    expect(bad.ok).toBe(false);
  });

  it("rejects an invalid key and a duplicate key", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const badKey = await createFieldDefinition({
      entity: "contact",
      key: "Bad Key",
      label: "Bad",
      type: "text",
    });
    expect(badKey.ok).toBe(false);

    const dup = await createFieldDefinition({
      entity: "contact",
      key: "linkedin",
      label: "Dupe",
      type: "text",
    });
    expect(dup.ok).toBe(false);
  });

  it("updates a definition's options and required flag", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const def = await createFieldDefinition({
      entity: "contact",
      key: "region",
      label: "Region",
      type: "select",
      config: { options: ["emea"] },
    });
    expect(def.ok).toBe(true);
    const upd = await updateFieldDefinition(id(def), { config: { options: ["emea", "apac"] } });
    expect(upd.ok).toBe(true);

    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const c = await createContact({
      firstName: "Reg",
      lastName: "Ion",
      customFields: { region: "apac" },
    });
    expect(c.ok).toBe(true);

    await deleteFieldDefinition(id(def));
  });

  it("does not apply org A's definitions to org B (cross-org isolation)", async () => {
    // org A has a required field; org B has none, so a bare contact succeeds
    // there and ignores org A's keys.
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const reqDef = await createFieldDefinition({
      entity: "contact",
      key: "mandatory_a",
      label: "Mandatory A",
      type: "text",
      required: true,
    });
    expect(reqDef.ok).toBe(true);

    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const c = await createContact({
      firstName: "Cross",
      lastName: "Org",
      customFields: { mandatory_a: "should-be-stripped" },
    });
    expect(c.ok).toBe(true);
    const saved = await db.contact.findUnique({ where: { id: id(c) } });
    // org B has no defs → unknown key stripped → empty object stored.
    expect(saved?.customFields).toEqual({});

    // And updating an org A contact still enforces org A's required field.
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const base = await createContact({
      firstName: "A",
      lastName: "Member",
      customFields: { mandatory_a: "x" },
    });
    expect(base.ok).toBe(true);
    const missing = await updateContact(id(base), { firstName: "A", lastName: "Member", customFields: {} });
    expect(missing.ok).toBe(false);

    await deleteFieldDefinition(id(reqDef));
  });
});

describe("custom fields on companies (D1)", () => {
  it("defines a field, sets it on a company, reads it back, and strips unknowns", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const def = await createFieldDefinition({
      entity: "company",
      key: "arr",
      label: "ARR",
      type: "number",
    });
    expect(def.ok).toBe(true);

    const created = await createCompany({
      name: "Acme",
      customFields: { arr: "1000", ignored: "drop-me" },
    });
    expect(created.ok).toBe(true);
    const saved = await db.company.findUnique({ where: { id: id(created) } });
    expect(saved?.customFields).toEqual({ arr: 1000 });

    const updated = await updateCompany(id(created), { name: "Acme", customFields: { arr: "2000" } });
    expect(updated.ok).toBe(true);
    const after = await db.company.findUnique({ where: { id: id(created) } });
    expect(after?.customFields).toEqual({ arr: 2000 });

    await deleteFieldDefinition(id(def));
  });

  it("rejects a missing required company field", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const def = await createFieldDefinition({
      entity: "company",
      key: "segment",
      label: "Segment",
      type: "text",
      required: true,
    });
    expect(def.ok).toBe(true);

    const bad = await createCompany({ name: "NoSeg", customFields: {} });
    expect(bad.ok).toBe(false);

    await deleteFieldDefinition(id(def));
  });
});

describe("custom fields on deals (D1)", () => {
  it("round-trips a deal custom field without breaking stage events/outbox", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const p = await createPipeline({ name: `CF-Deals-${Date.now()}` });
    const s = await createStage({ pipelineId: id(p), name: "Intake", order: 0 });
    const def = await createFieldDefinition({
      entity: "deal",
      key: "source",
      label: "Source",
      type: "select",
      config: { options: ["inbound", "outbound"] },
    });
    expect(p.ok && s.ok && def.ok).toBe(true);

    const created = await createDeal({
      title: "CF Deal",
      value: 500,
      stageId: id(s),
      customFields: { source: "inbound", ignored: "drop-me" },
    });
    expect(created.ok).toBe(true);
    const saved = await db.deal.findUnique({ where: { id: id(created) } });
    expect(saved?.customFields).toEqual({ source: "inbound" });
    // The existing stage-history side effect still fired.
    const events = await db.dealStageEvent.count({ where: { dealId: id(created) } });
    expect(events).toBeGreaterThan(0);

    const updated = await updateDeal(id(created), {
      title: "CF Deal",
      value: 500,
      stageId: id(s),
      status: "OPEN",
      customFields: { source: "outbound" },
    });
    expect(updated.ok).toBe(true);
    const after = await db.deal.findUnique({ where: { id: id(created) } });
    expect(after?.customFields).toEqual({ source: "outbound" });

    await deleteFieldDefinition(id(def));
  });

  it("rejects an invalid select value on a deal", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const p = await createPipeline({ name: `CF-Deals2-${Date.now()}` });
    const s = await createStage({ pipelineId: id(p), name: "Intake", order: 0 });
    const def = await createFieldDefinition({
      entity: "deal",
      key: "channel",
      label: "Channel",
      type: "select",
      config: { options: ["web"] },
    });
    expect(def.ok).toBe(true);

    const bad = await createDeal({
      title: "Bad",
      value: 1,
      stageId: id(s),
      customFields: { channel: "phone" },
    });
    expect(bad.ok).toBe(false);

    await deleteFieldDefinition(id(def));
  });
});

describe("plan-limit gates (D1)", () => {
  let limOrg = "", limUser = "";

  beforeAll(async () => {
    const ts = Date.now();
    const pw = await bcrypt.hash("pw", 4);
    const u = await db.user.create({ data: { email: `lim${ts}@t.io`, name: "Lim", passwordHash: pw } });
    const o = await db.organization.create({
      data: { name: `LimOrg-${ts}`, slug: `lim-org-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
    });
    limOrg = o.id; limUser = u.id;
  });

  afterAll(async () => {
    await db.savedView.deleteMany({ where: { orgId: limOrg } });
    await db.customFieldDefinition.deleteMany({ where: { orgId: limOrg } });
    await db.entitlement.deleteMany({ where: { orgId: limOrg } });
    await db.subscription.deleteMany({ where: { orgId: limOrg } });
    await db.membership.deleteMany({ where: { orgId: limOrg } });
    await db.organization.deleteMany({ where: { id: limOrg } });
    await db.user.deleteMany({ where: { id: limUser } });
  });

  it("blocks a new custom field once the customFields limit is reached", async () => {
    active = { userId: limUser, orgId: limOrg, role: "OWNER" };
    // Allow exactly one field via an override, then prove the second is blocked.
    await db.entitlement.create({ data: { orgId: limOrg, key: "customFields", intValue: 1 } });

    const first = await createFieldDefinition({ entity: "contact", key: "one", label: "One", type: "text" });
    expect(first.ok).toBe(true);

    // Limit counts across entities, so even a different entity is blocked.
    const second = await createFieldDefinition({ entity: "deal", key: "two", label: "Two", type: "text" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/plan limit/i);
  });

  it("blocks a new saved view once the savedViews limit is reached", async () => {
    active = { userId: limUser, orgId: limOrg, role: "OWNER" };
    await db.entitlement.create({ data: { orgId: limOrg, key: "savedViews", intValue: 1 } });

    const first = await createSavedView({ entity: "contact", name: "First", filters: {} });
    expect(first.ok).toBe(true);

    const second = await createSavedView({ entity: "contact", name: "Second", filters: {} });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/plan limit/i);
  });
});
