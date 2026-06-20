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
});

afterAll(async () => {
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.customFieldDefinition.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
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
