"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const decisionRoleEnum = z.enum(["CHAMPION", "ECONOMIC_BUYER", "USER", "INFLUENCER", "BLOCKER"]);

const contactSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  title: z.string().max(80).optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  isPrimary: z.union([z.literal("on"), z.boolean()]).optional(),
  decisionRole: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    decisionRoleEnum.optional(),
  ),
});

const clean = (v: string | undefined) => (v && v.length > 0 ? v : null);
const checkbox = (v: unknown) => v === true || v === "on";

export async function createContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  const created = await db.contact.create({
    data: {
      orgId,
      firstName: d.firstName,
      lastName: d.lastName,
      email: clean(d.email),
      phone: clean(d.phone),
      title: clean(d.title),
      companyId: clean(d.companyId),
      notes: clean(d.notes),
      isPrimary: checkbox(d.isPrimary),
      decisionRole: d.decisionRole ?? null,
    },
  });

  if (created.isPrimary && created.companyId) {
    await unsetOtherPrimaries(orgId, created.companyId, created.id);
  }

  revalidatePath("/contacts");
  return ok({ id: created.id });
}

export async function updateContact(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.contact.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;

  const newIsPrimary = checkbox(d.isPrimary);
  const newCompanyId = clean(d.companyId);

  await db.contact.update({
    where: { id },
    data: {
      firstName: d.firstName,
      lastName: d.lastName,
      email: clean(d.email),
      phone: clean(d.phone),
      title: clean(d.title),
      companyId: newCompanyId,
      notes: clean(d.notes),
      isPrimary: newIsPrimary,
      decisionRole: d.decisionRole ?? null,
    },
  });

  if (newIsPrimary && newCompanyId) {
    await unsetOtherPrimaries(orgId, newCompanyId, id);
  }

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

// Only one primary contact per company. Promoting this contact demotes peers.
async function unsetOtherPrimaries(orgId: string, companyId: string, keepId: string) {
  await db.contact.updateMany({
    where: { orgId, companyId, isPrimary: true, NOT: { id: keepId } },
    data: { isPrimary: false },
  });
}
