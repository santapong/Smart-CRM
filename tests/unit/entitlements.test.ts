import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

import {
  getOrCreateSubscription,
  getPlan,
  hasFeature,
  limitFor,
  withinLimit,
} from "@/lib/entitlements";
import { PLANS } from "@/lib/plans";

let orgId = "";

beforeAll(async () => {
  const ts = Date.now();
  const o = await db.organization.create({
    data: { name: `OrgENT-${ts}`, slug: `orgent-${ts}` },
  });
  orgId = o.id;
});

afterAll(async () => {
  await db.entitlement.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.$disconnect();
});

describe("entitlements & limits (M4)", () => {
  it("getOrCreateSubscription creates a free/active subscription", async () => {
    const sub = await getOrCreateSubscription(orgId);
    expect(sub.orgId).toBe(orgId);
    expect(sub.plan).toBe("free");
    expect(sub.status).toBe("active");

    // idempotent: second call returns the same row
    const again = await getOrCreateSubscription(orgId);
    expect(again.id).toBe(sub.id);
    const count = await db.subscription.count({ where: { orgId } });
    expect(count).toBe(1);
  });

  it("getPlan resolves the free plan and exposes its limits/features", async () => {
    const plan = await getPlan(orgId);
    expect(plan.key).toBe("free");
    expect(await limitFor(orgId, "pipelines")).toBe(PLANS.free.limits.pipelines);
    expect(await limitFor(orgId, "savedViews")).toBe(PLANS.free.limits.savedViews);
  });

  it("free plan gates premium features", async () => {
    expect(await hasFeature(orgId, "contacts")).toBe(true);
    expect(await hasFeature(orgId, "multiple_pipelines")).toBe(false);
    expect(await hasFeature(orgId, "automation")).toBe(false);
  });

  it("withinLimit is true below the cap and false at/over the boundary", async () => {
    // free allows 1 pipeline
    expect(await withinLimit(orgId, "pipelines", 0)).toBe(true);
    expect(await withinLimit(orgId, "pipelines", 1)).toBe(false);
    expect(await withinLimit(orgId, "pipelines", 2)).toBe(false);
  });

  it("an Entitlement intValue override changes a limit", async () => {
    await db.entitlement.create({
      data: { orgId, key: "pipelines", intValue: 5 },
    });
    expect(await limitFor(orgId, "pipelines")).toBe(5);
    expect(await withinLimit(orgId, "pipelines", 1)).toBe(true);
    expect(await withinLimit(orgId, "pipelines", 4)).toBe(true);
    expect(await withinLimit(orgId, "pipelines", 5)).toBe(false);
  });

  it("an Entitlement boolValue override unlocks a gated feature", async () => {
    await db.entitlement.create({
      data: { orgId, key: "automation", boolValue: true },
    });
    expect(await hasFeature(orgId, "automation")).toBe(true);
  });

  it("an intValue override of -1 means unlimited", async () => {
    await db.entitlement.create({
      data: { orgId, key: "savedViews", intValue: -1 },
    });
    expect(await withinLimit(orgId, "savedViews", 9999)).toBe(true);
  });
});
