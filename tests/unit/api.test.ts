import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

// Mirror the tenant mock used by the other action tests so the ADMIN-only
// createApiKey action can run with a controllable session.
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

import { createApiKey, listApiKeys, revokeApiKey } from "@/server/actions/api-keys";
import { hashSecret, parseBearer, resolveApiKey, requireScope } from "@/lib/api/auth";
import { GET as listContacts } from "@/app/api/v1/contacts/route";
import { GET as listLeads } from "@/app/api/v1/leads/route";

let orgA = "", orgB = "", userA = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `api${ts}@t.io`, name: "API", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `ApiOrgA-${ts}`, slug: `api-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({ data: { name: `ApiOrgB-${ts}`, slug: `api-orgb-${ts}` } });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;

  // Seed contacts in BOTH orgs to prove org-scoping in the list handler.
  await db.contact.createMany({
    data: [
      { orgId: orgA, firstName: "Alice", lastName: "A" },
      { orgId: orgA, firstName: "Aaron", lastName: "A2" },
      { orgId: orgB, firstName: "Bob", lastName: "B" },
    ],
  });
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.idempotencyKey.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.apiKey.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: userA } });
  await db.$disconnect();
});

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("API key creation + hashing (M12)", () => {
  it("createApiKey returns the full key once and stores only the hash", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const res = await createApiKey({ name: "CI key", scopes: ["contacts:read", "leads:read"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Format: sk_<prefix>_<secret>
    const parts = res.data.key.split("_");
    expect(parts[0]).toBe("sk");
    expect(parts.length).toBe(3);

    const row = await db.apiKey.findUnique({ where: { id: res.data.id } });
    expect(row).not.toBeNull();
    // Plaintext secret is never persisted; only its sha256.
    expect(row!.keyHash).toBe(hashSecret(parts[2]));
    expect(row!.keyHash).not.toContain(parts[2]);
    expect(row!.lookupPrefix).toBe(parts[1]);
  });

  it("createApiKey is ADMIN-gated", async () => {
    active = { userId: userA, orgId: orgA, role: "MEMBER" };
    const res = await createApiKey({ name: "nope", scopes: ["contacts:read"] });
    expect(res.ok).toBe(false);
  });
});

describe("API auth resolves org + rejects bad keys (M12)", () => {
  it("parseBearer accepts a well-formed key and rejects junk", () => {
    expect(parseBearer("Bearer sk_abc_def")).toEqual({ lookupPrefix: "abc", secret: "def" });
    expect(parseBearer("Bearer not-a-key")).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer("sk_abc_def")).toBeNull(); // missing "Bearer "
  });

  it("resolveApiKey returns the key's org for a valid key", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "resolve", scopes: ["contacts:read"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const auth = await resolveApiKey(`Bearer ${created.data.key}`);
    expect(auth).not.toBeNull();
    expect(auth!.orgId).toBe(orgA);
    expect(auth!.scopes).toContain("contacts:read");

    // lastUsedAt is stamped (best-effort) — allow the async update to land.
    await new Promise((r) => setTimeout(r, 50));
    const row = await db.apiKey.findUnique({ where: { id: created.data.id } });
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("resolveApiKey rejects a tampered secret", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "bad", scopes: ["contacts:read"] });
    if (!created.ok) return;
    const [, prefix] = created.data.key.split("_");
    const auth = await resolveApiKey(`Bearer sk_${prefix}_wrongsecret`);
    expect(auth).toBeNull();
  });

  it("requireScope enforces scopes and honors the wildcard", () => {
    expect(requireScope(["contacts:read"], "contacts:read")).toBe(true);
    expect(requireScope(["contacts:read"], "contacts:write")).toBe(false);
    expect(requireScope(["*"], "deals:write")).toBe(true);
  });
});

describe("v1 list handler is org-scoped + paginated (M12)", () => {
  it("returns only the key's org contacts with a Bearer key", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "list", scopes: ["contacts:read"] });
    if (!created.ok) return;

    const res = await listContacts(
      req("http://localhost/api/v1/contacts", { authorization: `Bearer ${created.data.key}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ org_id: string }>; next_cursor: string | null };
    expect(body.data.length).toBe(2); // only org A's two contacts
    expect(body.data.every((c) => c.org_id === orgA)).toBe(true);
    expect(body).toHaveProperty("next_cursor");
  });

  it("paginates with ?limit and returns a next_cursor", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "page", scopes: ["contacts:read"] });
    if (!created.ok) return;

    const first = await listContacts(
      req("http://localhost/api/v1/contacts?limit=1", { authorization: `Bearer ${created.data.key}` }),
    );
    const firstBody = (await first.json()) as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(firstBody.data.length).toBe(1);
    expect(firstBody.next_cursor).not.toBeNull();

    const second = await listContacts(
      req(`http://localhost/api/v1/contacts?limit=1&cursor=${firstBody.next_cursor}`, {
        authorization: `Bearer ${created.data.key}`,
      }),
    );
    const secondBody = (await second.json()) as { data: Array<{ id: string }>; next_cursor: string | null };
    expect(secondBody.data.length).toBe(1);
    expect(secondBody.data[0].id).not.toBe(firstBody.data[0].id);
  });

  it("rejects a request with no API key (401)", async () => {
    const res = await listContacts(req("http://localhost/api/v1/contacts"));
    expect(res.status).toBe(401);
  });

  it("enforces scopes: a contacts-only key cannot list leads (403)", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "scoped", scopes: ["contacts:read"] });
    if (!created.ok) return;
    const res = await listLeads(
      req("http://localhost/api/v1/leads", { authorization: `Bearer ${created.data.key}` }),
    );
    expect(res.status).toBe(403);
  });
});

describe("API key lifecycle (M12)", () => {
  it("listApiKeys never exposes the hash; revokeApiKey removes it", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const created = await createApiKey({ name: "lifecycle", scopes: ["deals:read"] });
    if (!created.ok) return;

    const listed = await listApiKeys();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const found = listed.data.find((k) => k.id === created.data.id);
      expect(found).toBeTruthy();
      expect(found as unknown as { keyHash?: string }).not.toHaveProperty("keyHash");
    }

    const revoked = await revokeApiKey(created.data.id);
    expect(revoked.ok).toBe(true);
    const gone = await db.apiKey.findUnique({ where: { id: created.data.id } });
    expect(gone).toBeNull();
  });
});
