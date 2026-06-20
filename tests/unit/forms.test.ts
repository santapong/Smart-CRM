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

import { createForm, updateForm, deleteForm, listForms } from "@/server/actions/forms";
import { ingestFormSubmission, pickEmail, type IngestForm } from "@/lib/lead-ingest";

let orgId = "", userId = "";

beforeAll(async () => {
  const ts = Date.now();
  const pw = await bcrypt.hash("pw", 4);
  const u = await db.user.create({ data: { email: `fm${ts}@t.io`, name: "FM", passwordHash: pw } });
  const o = await db.organization.create({
    data: { name: `FormOrg-${ts}`, slug: `form-org-${ts}`, memberships: { create: { userId: u.id, role: "OWNER" } } },
  });
  orgId = o.id; userId = u.id;
  // Lift the free-plan forms cap so the suite can create several forms.
  await db.entitlement.create({ data: { orgId, key: "forms", intValue: -1 } });
});

afterAll(async () => {
  await db.outboxEvent.deleteMany({ where: { orgId } });
  await db.formSubmission.deleteMany({ where: { orgId } });
  await db.form.deleteMany({ where: { orgId } });
  await db.lead.deleteMany({ where: { orgId } });
  await db.contact.deleteMany({ where: { orgId } });
  await db.entitlement.deleteMany({ where: { orgId } });
  await db.subscription.deleteMany({ where: { orgId } });
  await db.membership.deleteMany({ where: { orgId } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

const id = (r: unknown) => (r as { data: { id: string } }).data.id;

const FIELDS = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
];

async function makeForm(name = "Contact us") {
  active = { userId, orgId, role: "OWNER" };
  const r = await createForm({ name, fields: FIELDS });
  return r;
}

describe("forms CRUD (M8)", () => {
  it("creates, lists, updates and deletes a form (ADMIN)", async () => {
    const r = await makeForm("My form");
    expect(r.ok).toBe(true);
    const form = await db.form.findUnique({ where: { id: id(r) } });
    expect(form?.orgId).toBe(orgId);
    expect(form?.active).toBe(true);

    const list = await listForms();
    expect(list.some((f) => f.id === id(r))).toBe(true);

    const upd = await updateForm(id(r), { name: "Renamed", fields: FIELDS, active: false });
    expect(upd.ok).toBe(true);
    const after = await db.form.findUnique({ where: { id: id(r) } });
    expect(after?.name).toBe("Renamed");
    expect(after?.active).toBe(false);

    const del = await deleteForm(id(r));
    expect(del.ok).toBe(true);
    expect(await db.form.findUnique({ where: { id: id(r) } })).toBeNull();
  });

  it("rejects form create for a MEMBER (RBAC)", async () => {
    active = { userId, orgId, role: "MEMBER" };
    await expect(createForm({ name: "Nope", fields: FIELDS })).rejects.toThrow();
    active = { userId, orgId, role: "OWNER" };
  });

  it("pickEmail finds the email field value", () => {
    expect(pickEmail(FIELDS, { name: "X", email: "A@B.COM" })).toBe("a@b.com");
    expect(pickEmail(FIELDS, { name: "X" })).toBeNull();
  });
});

describe("public form submission ingest (M8)", () => {
  it("a submission creates a Lead + FormSubmission, bumps submitCount and emits events", async () => {
    const r = await makeForm("Lead capture");
    const form = await db.form.findUnique({ where: { id: id(r) } });
    const ingest: IngestForm = {
      id: form!.id,
      orgId,
      name: form!.name,
      fields: FIELDS,
      active: true,
    };

    const res = await ingestFormSubmission({
      data: { name: "Jane Doe", email: "jane@example.com", utm_source: "google" },
      form: ingest,
      utm: { utm_source: "google" },
    });
    expect(res.deduped).toBe(false);

    const lead = await db.lead.findUnique({ where: { id: res.leadId } });
    expect(lead?.orgId).toBe(orgId);
    expect(lead?.title).toBe("Jane Doe");
    expect(lead?.sourceChannel).toBe("web_form");

    const submission = await db.formSubmission.findUnique({ where: { id: res.submissionId } });
    expect(submission?.formId).toBe(form!.id);

    const reloaded = await db.form.findUnique({ where: { id: form!.id } });
    expect(reloaded?.submitCount).toBe(1);

    const created = await db.outboxEvent.count({ where: { orgId, name: "lead.created" } });
    expect(created).toBeGreaterThan(0);
    const submitted = await db.outboxEvent.count({ where: { orgId, name: "form.submitted" } });
    expect(submitted).toBeGreaterThan(0);
  });

  it("dedupes by email: a second submission reuses the existing contact's open lead", async () => {
    const r = await makeForm("Dedupe form");
    const form = await db.form.findUnique({ where: { id: id(r) } });
    const ingest: IngestForm = { id: form!.id, orgId, name: form!.name, fields: FIELDS, active: true };

    // Pre-existing contact with the same email.
    await db.contact.create({ data: { orgId, firstName: "Dup", lastName: "Lead", email: "dup@example.com" } });

    const first = await ingestFormSubmission({ form: ingest, data: { name: "Dup", email: "dup@example.com" } });
    expect(first.deduped).toBe(false);
    expect(first.contactId).not.toBeNull();

    const second = await ingestFormSubmission({ form: ingest, data: { name: "Dup again", email: "dup@example.com" } });
    expect(second.deduped).toBe(true);
    expect(second.leadId).toBe(first.leadId); // reused the same lead

    // Two submissions, one lead.
    const subs = await db.formSubmission.count({ where: { orgId, formId: form!.id } });
    expect(subs).toBe(2);
    const reloaded = await db.form.findUnique({ where: { id: form!.id } });
    expect(reloaded?.submitCount).toBe(2);
  });
});
