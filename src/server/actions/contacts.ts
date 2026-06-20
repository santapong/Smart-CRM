"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, optimisticUpdate, OCC_CONFLICT_MESSAGE } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { applyCustomFields } from "@/lib/custom-fields";
import { emit, EVENTS } from "@/lib/events";

const contactSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  title: z.string().max(80).optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  customFields: z.record(z.unknown()).optional(),
  // Optimistic concurrency (M1) — optional; when present the update is guarded
  // against concurrent writes via the row's `version`.
  expectedVersion: z.number().int().min(0).optional(),
});

function clean(v: string | undefined) {
  return v && v.length > 0 ? v : null;
}

export async function createContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const cf = await applyCustomFields(orgId, "contact", d.customFields ?? {});
  if (!cf.ok) return fail("Invalid custom fields", cf.errors);
  const created = await db.$transaction(async (tx) => {
    const contact = await tx.contact.create({
      data: {
        orgId,
        firstName: d.firstName,
        lastName: d.lastName,
        email: clean(d.email),
        phone: clean(d.phone),
        title: clean(d.title),
        companyId: clean(d.companyId),
        notes: clean(d.notes),
        customFields: cf.value as Prisma.InputJsonValue,
      },
    });
    await emit(tx, {
      orgId,
      name: EVENTS.CONTACT_CREATED,
      payload: { contactId: contact.id },
    });
    return contact;
  });
  revalidatePath("/contacts");
  return ok({ id: created.id });
  // TODO: same pattern for companies/deals
}

export async function updateContact(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.contact.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  const cf = await applyCustomFields(orgId, "contact", d.customFields ?? {});
  if (!cf.ok) return fail("Invalid custom fields", cf.errors);
  const res = await optimisticUpdate(db.contact, {
    id,
    orgId,
    expectedVersion: d.expectedVersion,
    data: {
      firstName: d.firstName,
      lastName: d.lastName,
      email: clean(d.email),
      phone: clean(d.phone),
      title: clean(d.title),
      companyId: clean(d.companyId),
      notes: clean(d.notes),
      customFields: cf.value as Prisma.InputJsonValue,
    },
  });
  if (!res.ok) return fail(OCC_CONFLICT_MESSAGE);
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  return ok({ id });
}

export async function deleteContact(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.contact.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/contacts");
  return ok({ id });
}
