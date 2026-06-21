"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db, optimisticUpdate, OCC_CONFLICT_MESSAGE } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { applyCustomFields } from "@/lib/custom-fields";

const companySchema = z.object({
  name: z.string().min(1).max(120),
  domain: z.string().max(120).optional().or(z.literal("")),
  industry: z.string().max(80).optional().or(z.literal("")),
  size: z.string().max(40).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  customFields: z.record(z.unknown()).optional(),
  // Optimistic concurrency (M1) — optional; guards against concurrent writes.
  expectedVersion: z.number().int().min(0).optional(),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createCompany(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = companySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const cf = await applyCustomFields(orgId, "company", d.customFields ?? {});
  if (!cf.ok) return fail("Invalid custom fields", cf.errors);
  const created = await db.company.create({
    data: {
      orgId,
      name: d.name,
      domain: c(d.domain),
      industry: c(d.industry),
      size: c(d.size),
      notes: c(d.notes),
      customFields: cf.value as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/companies");
  return ok({ id: created.id });
}

export async function updateCompany(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = companySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.company.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  const cf = await applyCustomFields(orgId, "company", d.customFields ?? {});
  if (!cf.ok) return fail("Invalid custom fields", cf.errors);
  const res = await optimisticUpdate(db.company, {
    id,
    orgId,
    expectedVersion: d.expectedVersion,
    data: {
      name: d.name,
      domain: c(d.domain),
      industry: c(d.industry),
      size: c(d.size),
      notes: c(d.notes),
      customFields: cf.value as Prisma.InputJsonValue,
    },
  });
  if (!res.ok) return fail(OCC_CONFLICT_MESSAGE);
  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
  return ok({ id });
}

export async function deleteCompany(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.company.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/companies");
  return ok({ id });
}
