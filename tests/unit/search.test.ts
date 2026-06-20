import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
}));

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

import { globalSearch, searchProvider } from "@/server/actions/search";
import { ensureSearchIndexes } from "@/lib/search-indexes";

let orgA = "", orgB = "", userA = "", userB = "";
const NEEDLE = `Zebrafish${Date.now()}`;
// A distinct token used to exercise ts_rank ordering (one deal repeats it).
const PHRASE_TOKEN = `Quokka${Date.now()}`;
// A distinct token used to exercise websearch_to_tsquery multi-word (AND) parsing.
const MULTI = `Pangolin${Date.now()}`;

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `sa${ts}@t.io`, name: "A", passwordHash: pw } });
  const ub = await db.user.create({ data: { email: `sb${ts}@t.io`, name: "B", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `SearchOrgA-${ts}`, slug: `s-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `SearchOrgB-${ts}`, slug: `s-orgb-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id; orgB = ob.id; userA = ua.id; userB = ub.id;

  // Same needle in both orgs, across all three entity types.
  const stageA = await db.pipelineStage.create({ data: { orgId: orgA, name: "Lead", order: 0 } });
  const stageB = await db.pipelineStage.create({ data: { orgId: orgB, name: "Lead", order: 0 } });
  await db.contact.create({ data: { orgId: orgA, firstName: NEEDLE, lastName: "InOrgA" } });
  await db.contact.create({ data: { orgId: orgB, firstName: NEEDLE, lastName: "InOrgB" } });
  await db.company.create({ data: { orgId: orgA, name: `${NEEDLE} Co A` } });
  await db.company.create({ data: { orgId: orgB, name: `${NEEDLE} Co B` } });
  await db.deal.create({ data: { orgId: orgA, title: `${NEEDLE} Deal A`, stageId: stageA.id } });
  await db.deal.create({ data: { orgId: orgB, title: `${NEEDLE} Deal B`, stageId: stageB.id } });

  // Ranking fixture (org A): both deals match the single token PHRASE_TOKEN, but
  // the first repeats it (higher term frequency) so ts_rank scores it higher.
  await db.deal.create({ data: { orgId: orgA, title: `${PHRASE_TOKEN} ${PHRASE_TOKEN} top`, stageId: stageA.id } });
  await db.deal.create({ data: { orgId: orgA, title: `${PHRASE_TOKEN} lower`, stageId: stageA.id } });
  // Multi-word fixture (org A): websearch AND-matches every word, so only this
  // deal (containing BOTH words) matches the query "<MULTI> migration".
  await db.deal.create({ data: { orgId: orgA, title: `${MULTI} migration project`, stageId: stageA.id } });
  await db.deal.create({ data: { orgId: orgA, title: `${MULTI} unrelated`, stageId: stageA.id } });

  // GIN indexes are best-effort (a performance optimization). Correctness must
  // hold without them, so failures here are swallowed by ensureSearchIndexes.
  await ensureSearchIndexes(db);
});

afterAll(async () => {
  await db.deal.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.contact.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.company.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.pipelineStage.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.membership.deleteMany({ where: { orgId: { in: [orgA, orgB] } } });
  await db.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  await db.$disconnect();
});

describe("globalSearch", () => {
  it("finds contacts, companies, and deals in the active org only", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch(NEEDLE);
    expect(r.ok).toBe(true);
    const hits = (r as any).data.hits as { type: string; title: string }[];

    expect(hits.some((h) => h.type === "contact" && h.title.includes("InOrgA"))).toBe(true);
    expect(hits.some((h) => h.type === "company" && h.title.includes("Co A"))).toBe(true);
    expect(hits.some((h) => h.type === "deal" && h.title.includes("Deal A"))).toBe(true);

    // Nothing from org B may leak.
    expect(hits.some((h) => h.title.includes("InOrgB") || h.title.includes("Co B") || h.title.includes("Deal B"))).toBe(
      false
    );
  });

  it("rejects empty queries", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch("   ");
    expect(r.ok).toBe(false);
  });

  it("uses the Postgres FTS provider by default (no MEILISEARCH_HOST)", async () => {
    expect(await searchProvider()).toBe("postgres");
  });

  it("ranks the more relevant match first via ts_rank", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch(PHRASE_TOKEN);
    expect(r.ok).toBe(true);
    const deals = ((r as any).data.hits as { type: string; title: string }[]).filter((h) => h.type === "deal");
    // Both deals match the token…
    expect(deals.some((d) => d.title.includes("top"))).toBe(true);
    expect(deals.some((d) => d.title.includes("lower"))).toBe(true);
    // …but the one that repeats the token (higher term frequency) ranks first.
    const idxTop = deals.findIndex((d) => d.title.includes("top"));
    const idxLower = deals.findIndex((d) => d.title.includes("lower"));
    expect(idxTop).toBeGreaterThanOrEqual(0);
    expect(idxTop).toBeLessThan(idxLower);
  });

  it("AND-matches multi-word queries via websearch_to_tsquery", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const r = await globalSearch(`${MULTI} migration`);
    expect(r.ok).toBe(true);
    const deals = ((r as any).data.hits as { type: string; title: string }[]).filter((h) => h.type === "deal");
    // Only the deal containing BOTH words matches; the "unrelated" one does not.
    expect(deals.some((d) => d.title.includes("migration project"))).toBe(true);
    expect(deals.some((d) => d.title.includes("unrelated"))).toBe(false);
  });

  it("keeps org isolation under FTS (org B sees only its own rows)", async () => {
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const r = await globalSearch(NEEDLE);
    expect(r.ok).toBe(true);
    const hits = (r as any).data.hits as { type: string; title: string }[];
    expect(hits.some((h) => h.title.includes("InOrgB") || h.title.includes("Co B") || h.title.includes("Deal B"))).toBe(true);
    // Nothing from org A may leak, including the org-A-only ranking fixtures.
    expect(
      hits.some(
        (h) =>
          h.title.includes("InOrgA") ||
          h.title.includes("Co A") ||
          h.title.includes("Deal A") ||
          h.title.includes(PHRASE_TOKEN) ||
          h.title.includes(MULTI),
      ),
    ).toBe(false);
  });
});
