"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const companySchema = z.object({
  name: z.string().min(1).max(120),
  domain: z.string().max(120).optional().or(z.literal("")),
  industry: z.string().max(80).optional().or(z.literal("")),
  size: z.string().max(40).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createCompany(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = companySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const created = await db.company.create({
    data: { orgId, name: d.name, domain: c(d.domain), industry: c(d.industry), size: c(d.size), notes: c(d.notes) },
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
  await db.company.update({
    where: { id },
    data: { name: d.name, domain: c(d.domain), industry: c(d.industry), size: c(d.size), notes: c(d.notes) },
  });
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
