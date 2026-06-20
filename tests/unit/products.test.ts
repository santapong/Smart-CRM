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

import { createProduct, updateProduct, deleteProduct } from "@/server/actions/products";
import { addLineItem, updateLineItem, removeLineItem } from "@/server/actions/deal-products";
import { dealRevenue } from "@/lib/products";

let orgA = "", orgB = "", userA = "", userB = "", stageId = "", dealId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `pra${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `prb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `ProdOrgA-${ts}`, slug: `prod-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `ProdOrgB-${ts}`, slug: `prod-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;
  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  const s = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: p.id, name: "Lead", order: 0 } });
  stageId = s.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.dealProduct.deleteMany({ where: { orgId: { in: orgs } } });
  await db.product.deleteMany({ where: { orgId: { in: orgs } } });
  await db.dealStageEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("dealRevenue (M13a, pure)", () => {
  it("splits one-time vs recurring and normalises MRR/ARR", () => {
    const rev = dealRevenue([
      { quantity: 2, unitPrice: 100, discount: 0, billing: "one_time" }, // 200 one-time
      { quantity: 1, unitPrice: 50, discount: null, billing: "monthly" }, // 50/mo
      { quantity: 1, unitPrice: 300, discount: null, billing: "quarterly" }, // 100/mo
      { quantity: 1, unitPrice: 1200, discount: null, billing: "annually" }, // 100/mo
    ]);
    expect(rev.oneTime).toBe(200);
    expect(rev.mrr).toBe(250);
    expect(rev.arr).toBe(3000);
  });

  it("applies discounts and never goes negative", () => {
    const rev = dealRevenue([
      { quantity: 3, unitPrice: 100, discount: 50, billing: "one_time" }, // 250
      { quantity: 1, unitPrice: 10, discount: 9999, billing: "monthly" }, // clamped to 0
    ]);
    expect(rev.oneTime).toBe(250);
    expect(rev.mrr).toBe(0);
  });
});

describe("deal line items (M13a)", () => {
  beforeAll(async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const deal = await db.deal.create({
      data: { orgId: orgA, title: "Line item deal", stageId, value: 0 },
    });
    dealId = deal.id;
  });

  it("recomputes Deal.value from one-time items and exposes MRR/ARR", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r1 = await addLineItem(dealId, { name: "Setup fee", quantity: 1, unitPrice: 500, billing: "one_time" });
    expect(r1.ok).toBe(true);
    let deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(Number(deal?.value)).toBe(500);

    const r2 = await addLineItem(dealId, { name: "Subscription", quantity: 2, unitPrice: 100, billing: "monthly" });
    expect(r2.ok).toBe(true);
    const rev = (r2 as { data: { revenue: { oneTime: number; mrr: number; arr: number } } }).data.revenue;
    expect(rev.oneTime).toBe(500);
    expect(rev.mrr).toBe(200);
    expect(rev.arr).toBe(2400);

    // Deal.value reflects only one-time items.
    deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(Number(deal?.value)).toBe(500);
  });

  it("recomputes value when a line item is updated or removed", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const add = await addLineItem(dealId, { name: "Add-on", quantity: 1, unitPrice: 250, billing: "one_time" });
    let deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(Number(deal?.value)).toBe(750); // 500 + 250

    const upd = await updateLineItem(id(add), { quantity: 2 }); // 2 * 250 = 500
    expect(upd.ok).toBe(true);
    deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(Number(deal?.value)).toBe(1000); // 500 + 500

    const rm = await removeLineItem(id(add));
    expect(rm.ok).toBe(true);
    deal = await db.deal.findUnique({ where: { id: dealId } });
    expect(Number(deal?.value)).toBe(500);
  });

  it("links a catalog product and snapshots its name", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const prod = await createProduct({ name: "Pro plan", price: 99 });
    expect(prod.ok).toBe(true);
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const add = await addLineItem(dealId, { productId: id(prod), name: "Pro plan", quantity: 1, unitPrice: 99, billing: "monthly" });
    expect(add.ok).toBe(true);
    const line = await db.dealProduct.findUnique({ where: { id: id(add) } });
    expect(line?.productId).toBe(id(prod));
    expect(line?.name).toBe("Pro plan");
  });

  it("rejects a line item on a deal from another org", async () => {
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const r = await addLineItem(dealId, { name: "Sneaky", quantity: 1, unitPrice: 1, billing: "one_time" });
    expect(r.ok).toBe(false);
  });
});

describe("product catalog RBAC (M13a)", () => {
  it("forbids non-admins from creating products", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    await expect(createProduct({ name: "Nope", price: 1 })).rejects.toThrow();
  });

  it("allows ADMIN to create, update and delete products", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const created = await createProduct({ name: "Widget", sku: "W-1", price: 10, cost: 4 });
    expect(created.ok).toBe(true);
    const upd = await updateProduct(id(created), { price: 12, active: false });
    expect(upd.ok).toBe(true);
    const row = await db.product.findUnique({ where: { id: id(created) } });
    expect(Number(row?.price)).toBe(12);
    expect(row?.active).toBe(false);
    const del = await deleteProduct(id(created));
    expect(del.ok).toBe(true);
  });

  it("scopes product deletes to the active org", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const created = await createProduct({ name: "OrgA only", price: 5 });
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    const del = await deleteProduct(id(created));
    expect(del.ok).toBe(false);
    // still exists under org A
    const row = await db.product.findUnique({ where: { id: id(created) } });
    expect(row?.orgId).toBe(orgA);
  });
});
