import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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
  renderTemplate,
  lookupPath,
  buildMergeContext,
  AVAILABLE_MERGE_FIELDS,
} from "@/lib/documents";
import {
  createDocumentTemplate,
  updateDocumentTemplate,
  deleteDocumentTemplate,
  generateDocument,
  deleteDocument,
} from "@/server/actions/documents";

describe("merge renderer (M18) — pure", () => {
  const ctx = {
    deal: { title: "Acme renewal", value: "5000", stage: "Demo" },
    contact: { fullName: "Ada Lovelace", email: "ada@x.io" },
    company: { name: "Acme" },
    today: "2026-06-20",
  };

  it("replaces known dot-path tokens", () => {
    expect(renderTemplate("Deal: {{deal.title}}", ctx)).toBe("Deal: Acme renewal");
  });

  it("handles nested paths and multiple tokens", () => {
    const out = renderTemplate("{{contact.fullName}} <{{contact.email}}> — {{company.name}}", ctx);
    expect(out).toBe("Ada Lovelace <ada@x.io> — Acme");
  });

  it("trims whitespace inside the braces", () => {
    expect(renderTemplate("Hi {{  contact.fullName  }}!", ctx)).toBe("Hi Ada Lovelace!");
  });

  it("replaces unknown tokens with the empty string", () => {
    expect(renderTemplate("X{{nope.missing}}Y", ctx)).toBe("XY");
    expect(renderTemplate("X{{deal.unknownField}}Y", ctx)).toBe("XY");
  });

  it("leaves non-token text intact (and tolerates stray braces)", () => {
    expect(renderTemplate("Plain text, no tokens.", ctx)).toBe("Plain text, no tokens.");
    expect(renderTemplate("price < 5 and x > 3", ctx)).toBe("price < 5 and x > 3");
  });

  it("renders {{today}}", () => {
    expect(renderTemplate("Date: {{today}}", ctx)).toBe("Date: 2026-06-20");
  });

  it("stringifies non-string values (numbers)", () => {
    expect(renderTemplate("Value: {{deal.value}}", { deal: { value: 5000 } })).toBe("Value: 5000");
  });

  it("lookupPath resolves and returns undefined for missing/typed paths", () => {
    expect(lookupPath(ctx, "deal.title")).toBe("Acme renewal");
    expect(lookupPath(ctx, "deal.title.nope")).toBeUndefined();
    expect(lookupPath(ctx, "missing")).toBeUndefined();
  });
});

describe("buildMergeContext (M18) — pure", () => {
  it("assembles context from entities with a fixed `now`", () => {
    const out = buildMergeContext({
      deal: {
        // Only the fields the builder reads are needed.
        title: "Acme renewal",
        value: 5000 as unknown as never,
        currency: "USD",
        status: "OPEN",
        closeDate: new Date("2026-12-31T00:00:00Z"),
        stage: { name: "Demo" },
      } as never,
      contact: {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@x.io",
        phone: null,
        title: "CTO",
      } as never,
      company: { name: "Acme", domain: "acme.com", industry: "SaaS", size: null } as never,
      org: { name: "My Org", slug: "my-org" },
      now: new Date("2026-06-20T12:00:00Z"),
    });
    const deal = out.deal as Record<string, unknown>;
    const contact = out.contact as Record<string, unknown>;
    expect(out.today).toBe("2026-06-20");
    expect(deal.title).toBe("Acme renewal");
    expect(deal.value).toBe("5000");
    expect(deal.stage).toBe("Demo");
    expect(deal.closeDate).toBe("2026-12-31");
    expect(contact.fullName).toBe("Ada Lovelace");
    expect((out.company as Record<string, unknown>).name).toBe("Acme");
    expect((out.org as Record<string, unknown>).name).toBe("My Org");
  });

  it("omits entities that are absent (tokens then render empty)", () => {
    const out = buildMergeContext({ org: { name: "Solo", slug: "solo" } });
    expect(out.deal).toBeUndefined();
    expect(renderTemplate("{{deal.title}}|{{org.name}}", out)).toBe("|Solo");
  });

  it("AVAILABLE_MERGE_FIELDS lists tokens in {{...}} form", () => {
    expect(AVAILABLE_MERGE_FIELDS.length).toBeGreaterThan(0);
    for (const f of AVAILABLE_MERGE_FIELDS) {
      expect(f.token.startsWith("{{")).toBe(true);
      expect(f.token.endsWith("}}")).toBe(true);
    }
  });
});

// ---- DB-backed action tests ----

let orgA = "",
  orgB = "",
  userA = "",
  userB = "",
  memberA = "",
  stageA = "",
  pipelineA = "",
  contactA = "",
  companyA = "",
  dealA = "";

beforeAll(async () => {
  const ts = Date.now();
  const ua = await db.user.create({ data: { email: `doc-a-${ts}@t.io`, name: "Doc A" } });
  const ub = await db.user.create({ data: { email: `doc-b-${ts}@t.io`, name: "Doc B" } });
  const mem = await db.user.create({ data: { email: `doc-m-${ts}@t.io`, name: "Doc M" } });
  const oa = await db.organization.create({
    data: { name: `DocA-${ts}`, slug: `doc-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `DocB-${ts}`, slug: `doc-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
  userB = ub.id;
  memberA = mem.id;
  await db.membership.create({ data: { orgId: orgA, userId: memberA, role: "MEMBER" } });
  // Lift the free-plan documentTemplates cap (free = 1) so suites can create freely.
  await db.entitlement.create({ data: { orgId: orgA, key: "documentTemplates", intValue: -1 } });

  const p = await db.pipeline.create({ data: { orgId: orgA, name: "Sales", isDefault: true, order: 0 } });
  pipelineA = p.id;
  const st = await db.pipelineStage.create({ data: { orgId: orgA, pipelineId: pipelineA, name: "Demo", order: 0 } });
  stageA = st.id;
  const company = await db.company.create({ data: { orgId: orgA, name: "Acme Inc" } });
  companyA = company.id;
  const contact = await db.contact.create({
    data: { orgId: orgA, firstName: "Ada", lastName: "Lovelace", email: "ada@acme.io", companyId: companyA },
  });
  contactA = contact.id;
  const deal = await db.deal.create({
    data: {
      orgId: orgA,
      title: "Acme renewal",
      value: 5000,
      status: "OPEN",
      stageId: stageA,
      pipelineId: pipelineA,
      contactId: contactA,
      companyId: companyA,
      ownerId: userA,
    },
  });
  dealA = deal.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.signatureRequest.deleteMany({ where: { orgId: { in: orgs } } });
  await db.attachment.deleteMany({ where: { orgId: { in: orgs } } });
  await db.document.deleteMany({ where: { orgId: { in: orgs } } });
  await db.documentTemplate.deleteMany({ where: { orgId: { in: orgs } } });
  await db.deal.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.company.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: orgs } } });
  await db.pipeline.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB, memberA] } } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

describe("document template CRUD (M18)", () => {
  it("forbids non-admins from creating templates", async () => {
    active = { userId: memberA, orgId: orgA, role: "MEMBER" };
    const r = await createDocumentTemplate({ name: "Nope", body: "x" });
    expect(r.ok).toBe(false);
  });

  it("ADMIN creates, updates, and deletes a template; enforces unique name", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const a = await createDocumentTemplate({ name: "Proposal", body: "Hello {{contact.fullName}}" });
    expect(a.ok).toBe(true);
    const dup = await createDocumentTemplate({ name: "Proposal", body: "x" });
    expect(dup.ok).toBe(false);
    const upd = await updateDocumentTemplate(id(a), { body: "Updated body" });
    expect(upd.ok).toBe(true);
    const row = await db.documentTemplate.findUnique({ where: { id: id(a) } });
    expect(row?.body).toBe("Updated body");
    const del = await deleteDocumentTemplate(id(a));
    expect(del.ok).toBe(true);
  });
});

describe("generateDocument (M18)", () => {
  it("renders merge fields from the deal + its linked contact/company and emits an event", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const tpl = await createDocumentTemplate({
      name: "Deal letter",
      body: "To {{contact.fullName}} at {{company.name}} re {{deal.title}} ({{deal.value}})",
    });
    active = { userId: memberA, orgId: orgA, role: "MEMBER" }; // generate is not admin-gated
    const gen = await generateDocument({ templateId: id(tpl), dealId: dealA });
    expect(gen.ok).toBe(true);
    const doc = await db.document.findUnique({ where: { id: id(gen) } });
    expect(doc?.content).toBe("To Ada Lovelace at Acme Inc re Acme renewal (5000)");
    expect(doc?.dealId).toBe(dealA);
    expect(doc?.contactId).toBe(contactA);
    expect(doc?.companyId).toBe(companyA);

    const events = await db.outboxEvent.findMany({ where: { orgId: orgA, name: "document.generated" } });
    expect(events.some((e) => (e.payload as { documentId?: string }).documentId === doc?.id)).toBe(true);

    const del = await deleteDocument(id(gen));
    expect(del.ok).toBe(true);
  });

  it("requires at least one target and rejects a foreign template", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const tpl = await createDocumentTemplate({ name: "Standalone", body: "Hi {{today}}" });

    // No target entity → validation error.
    const noTarget = await generateDocument({ templateId: id(tpl) });
    expect(noTarget.ok).toBe(false);

    // Cross-org: org B cannot use org A's template.
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const cross = await generateDocument({ templateId: id(tpl), companyId: companyA });
    expect(cross.ok).toBe(false);
  });
});

describe("tenant isolation (M18)", () => {
  it("org B admin cannot update or delete org A's template", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const a = await createDocumentTemplate({ name: "OrgA only", body: "x" });
    active = { userId: userB, orgId: orgB, role: "ADMIN" };
    expect((await updateDocumentTemplate(id(a), { body: "hijack" })).ok).toBe(false);
    expect((await deleteDocumentTemplate(id(a))).ok).toBe(false);
    const still = await db.documentTemplate.findUnique({ where: { id: id(a) } });
    expect(still?.orgId).toBe(orgA);
    expect(still?.body).toBe("x");
  });
});
