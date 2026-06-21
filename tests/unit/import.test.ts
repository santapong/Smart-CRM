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

import { parseCsv } from "@/lib/import/parse";
import { suggestMapping } from "@/lib/import/runner";
import { createImportJob, getImportJob, previewCsv } from "@/server/actions/imports";

let orgA = "",
  orgB = "",
  userA = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const ua = await db.user.create({ data: { email: `imp${ts}@t.io`, name: "A", passwordHash: pw } });
  const oa = await db.organization.create({
    data: { name: `ImpOrgA-${ts}`, slug: `imp-orga-${ts}`, memberships: { create: { userId: ua.id, role: "OWNER" } } },
  });
  const ob = await db.organization.create({
    data: { name: `ImpOrgB-${ts}`, slug: `imp-orgb-${ts}` },
  });
  orgA = oa.id;
  orgB = ob.id;
  userA = ua.id;
});

afterAll(async () => {
  const orgs = [orgA, orgB];
  await db.importRowError.deleteMany({ where: { importJob: { orgId: { in: orgs } } } });
  await db.importJob.deleteMany({ where: { orgId: { in: orgs } } });
  await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
  await db.company.deleteMany({ where: { orgId: { in: orgs } } });
  await db.entitlement.deleteMany({ where: { orgId: { in: orgs } } });
  await db.subscription.deleteMany({ where: { orgId: { in: orgs } } });
  await db.membership.deleteMany({ where: { orgId: { in: orgs } } });
  await db.organization.deleteMany({ where: { id: { in: orgs } } });
  await db.user.deleteMany({ where: { id: { in: [userA] } } });
  await db.$disconnect();
});

describe("parseCsv (M13c)", () => {
  it("parses headers and rows, tolerating quotes and blank lines", () => {
    const csv = 'First,Last,Email\nAda,Lovelace,ada@x.io\n"Grace","Hopper","grace@x.io"\n\n';
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["First", "Last", "Email"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ First: "Ada", Last: "Lovelace", Email: "ada@x.io" });
    expect(rows[1].Email).toBe("grace@x.io");
  });

  it("handles embedded commas in quoted cells", () => {
    const csv = "Name,Notes\nAcme,\"a, b, c\"\n";
    const { rows } = parseCsv(csv);
    expect(rows[0].Notes).toBe("a, b, c");
  });
});

describe("suggestMapping (M13c)", () => {
  it("fuzzy-matches headers to contact fields", () => {
    const m = suggestMapping("contact", ["First Name", "Last Name", "E-mail", "Phone Number", "Unknown"]);
    expect(m["First Name"]).toBe("firstName");
    expect(m["Last Name"]).toBe("lastName");
    expect(m["E-mail"]).toBe("email");
    expect(m["Phone Number"]).toBe("phone");
    expect(m["Unknown"]).toBe("");
  });
});

const counters = (r: Awaited<ReturnType<typeof getImportJob>>) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("processImportJob via createImportJob (M13c)", () => {
  it("imports contacts (create), records errors, and counts", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const csv = [
      "First,Last,Email",
      "Ada,Lovelace,ada@import.io",
      "Grace,Hopper,grace@import.io",
      "Bad,Row,not-an-email", // invalid: malformed email
    ].join("\n");
    const mapping = { First: "firstName", Last: "lastName", Email: "email" };
    const res = await createImportJob({ entity: "contact", raw: csv, mapping, dupeMode: "skip" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const job = counters(await getImportJob(res.data.id));
    expect(job.status).toBe("done");
    expect(job.created).toBe(2);
    expect(job.failed).toBe(1);
    expect(job.totalRows).toBe(3);
    expect(job.errors).toHaveLength(1);

    const ada = await db.contact.findFirst({ where: { orgId: orgA, email: "ada@import.io" } });
    expect(ada?.firstName).toBe("Ada");
  });

  it("dedupe skip mode leaves an existing contact untouched", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    // ada@import.io already exists from the previous test.
    const csv = ["First,Last,Email", "Adelaide,Lovelace,ada@import.io"].join("\n");
    const mapping = { First: "firstName", Last: "lastName", Email: "email" };
    const res = await createImportJob({ entity: "contact", raw: csv, mapping, dupeMode: "skip" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const job = counters(await getImportJob(res.data.id));
    expect(job.created).toBe(0);
    expect(job.updated).toBe(0);
    expect(job.processed).toBe(1);
    const ada = await db.contact.findFirst({ where: { orgId: orgA, email: "ada@import.io" } });
    expect(ada?.firstName).toBe("Ada"); // unchanged
  });

  it("dedupe update mode updates an existing contact", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const csv = ["First,Last,Email,Phone", "Adelaide,Lovelace,ada@import.io,555-1234"].join("\n");
    const mapping = { First: "firstName", Last: "lastName", Email: "email", Phone: "phone" };
    const res = await createImportJob({ entity: "contact", raw: csv, mapping, dupeMode: "update" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const job = counters(await getImportJob(res.data.id));
    expect(job.updated).toBe(1);
    expect(job.created).toBe(0);
    const ada = await db.contact.findFirst({ where: { orgId: orgA, email: "ada@import.io" } });
    expect(ada?.firstName).toBe("Adelaide");
    expect(ada?.phone).toBe("555-1234");
  });

  it("previewCsv returns headers, sample rows and a suggested mapping", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const csv = ["First Name,Last Name,Email", "Alan,Turing,alan@x.io"].join("\n");
    const res = await previewCsv({ entity: "contact", raw: csv });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(res.data.rows).toHaveLength(1);
    expect(res.data.suggestedMapping["First Name"]).toBe("firstName");
  });

  it("is org-scoped: a job created for org A is invisible to org B", async () => {
    active = { userId: userA, orgId: orgA, role: "OWNER" };
    const csv = ["First,Last,Email", "Iso,Lated,iso@import.io"].join("\n");
    const res = await createImportJob({ entity: "contact", raw: csv, mapping: { First: "firstName", Last: "lastName", Email: "email" }, dupeMode: "skip" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    active = { userId: userA, orgId: orgB, role: "OWNER" };
    const cross = await getImportJob(res.data.id);
    expect(cross.ok).toBe(false);
  });
});
