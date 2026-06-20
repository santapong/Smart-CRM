import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
  esignConfigured,
  requestSignature,
  ESIGN_NOT_CONFIGURED,
  ESIGN_PROVIDER,
} from "@/lib/esign";
import { createSignatureRequest } from "@/server/actions/esign";

beforeEach(() => {
  delete process.env.DROPBOX_SIGN_API_KEY;
});
afterEach(() => {
  delete process.env.DROPBOX_SIGN_API_KEY;
});

describe("esign lib (M18) — env gating", () => {
  it("esignConfigured() is false with no provider env", () => {
    expect(esignConfigured()).toBe(false);
  });

  it("esignConfigured() is true when DROPBOX_SIGN_API_KEY is set", () => {
    process.env.DROPBOX_SIGN_API_KEY = "key-not-real";
    expect(esignConfigured()).toBe(true);
  });

  it("requestSignature returns the not-configured result when off (no throw)", async () => {
    const r = await requestSignature({
      title: "Doc",
      content: "body",
      signers: [{ email: "ada@x.io" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(ESIGN_NOT_CONFIGURED);
  });

  it("requestSignature stays scaffolded (TODO) even when configured", async () => {
    process.env.DROPBOX_SIGN_API_KEY = "key-not-real";
    const r = await requestSignature({ title: "Doc", content: "b", signers: [{ email: "ada@x.io" }] });
    // No SDK is wired yet — the scaffold returns not-configured rather than sending.
    expect(r.ok).toBe(false);
  });
});

// ---- DB-backed action tests ----

let orgA = "",
  orgB = "",
  userA = "",
  userB = "",
  memberA = "",
  docA = "";

beforeAll(async () => {
  const ts = Date.now();
  const ua = await db.user.create({ data: { email: `es-a-${ts}@t.io`, name: "ES A" } });
  const ub = await db.user.create({ data: { email: `es-b-${ts}@t.io`, name: "ES B" } });
  const mem = await db.user.create({ data: { email: `es-m-${ts}@t.io`, name: "ES M" } });
  const oa = await db.organization.create({
    data: { name: `ESA-${ts}`, slug: `es-a-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `ESB-${ts}`, slug: `es-b-${ts}`, memberships: { create: { userId: ub.id, role: "OWNER" } } },
  });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
  userB = ub.id;
  memberA = mem.id;
  await db.membership.create({ data: { orgId: orgA, userId: memberA, role: "MEMBER" } });

  const doc = await db.document.create({
    data: { orgId: orgA, title: "MSA", content: "Agreement text", status: "DRAFT", createdById: userA },
  });
  docA = doc.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.signatureRequest.deleteMany({ where: { orgId: { in: orgs } } });
  await db.document.deleteMany({ where: { orgId: { in: orgs } } });
  await db.outboxEvent.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA, userB, memberA] } } });
  await db.$disconnect();
});

describe("createSignatureRequest (M18) — graceful when unconfigured", () => {
  it("forbids non-admins", async () => {
    active = { userId: memberA, orgId: orgA, role: "MEMBER" };
    const r = await createSignatureRequest({ documentId: docA, signers: [{ email: "ada@x.io" }] });
    expect(r.ok).toBe(false);
  });

  it("records a PENDING request and returns the not-configured message when eSign is off", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await createSignatureRequest({
      documentId: docA,
      signers: [{ email: "ada@acme.io", name: "Ada" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.configured).toBe(false);
      expect(r.data.message).toMatch(/DROPBOX_SIGN_API_KEY/);
    }
    const row = r.ok ? await db.signatureRequest.findUnique({ where: { id: r.data.id } }) : null;
    expect(row?.status).toBe("PENDING");
    expect(row?.provider).toBe(ESIGN_PROVIDER);
    expect(row?.externalId).toBeNull();

    // Emits a signature.requested event.
    const events = await db.outboxEvent.findMany({ where: { orgId: orgA, name: "signature.requested" } });
    expect(events.length).toBeGreaterThan(0);
  });

  it("validates signer emails", async () => {
    active = { userId: userA, orgId: orgA, role: "ADMIN" };
    const r = await createSignatureRequest({ documentId: docA, signers: [{ email: "not-an-email" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects a document from another org (tenant isolation)", async () => {
    active = { userId: userB, orgId: orgB, role: "OWNER" };
    const r = await createSignatureRequest({ documentId: docA, signers: [{ email: "ada@x.io" }] });
    expect(r.ok).toBe(false);
  });
});
