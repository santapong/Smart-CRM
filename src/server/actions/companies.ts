"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const tierEnum = z.enum(["SMB", "MID_MARKET", "ENTERPRISE", "STRATEGIC"]);

const companySchema = z.object({
  name: z.string().min(1).max(120),
  domain: z.string().max(120).optional().or(z.literal("")),
  industry: z.string().max(80).optional().or(z.literal("")),
  size: z.string().max(40).optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  tier: z.preprocess((v) => (v === "" || v == null ? undefined : v), tierEnum.optional()),
  parentCompanyId: z.string().optional().or(z.literal("")),
  arr: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().max(1e12).optional(),
  ),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createCompany(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = companySchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  // Parent must be in the same org and cannot be the row itself (no cycle
  // detection needed on create — id doesn't exist yet).
  if (d.parentCompanyId) {
    const parent = await db.company.findFirst({ where: { id: d.parentCompanyId, orgId } });
    if (!parent) return fail("Invalid parent account");
  }

  const created = await db.company.create({
    data: {
      orgId,
      name: d.name,
      domain: c(d.domain),
      industry: c(d.industry),
      size: c(d.size),
      notes: c(d.notes),
      tier: d.tier ?? "SMB",
      parentCompanyId: c(d.parentCompanyId),
      arr: d.arr ?? null,
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

  if (d.parentCompanyId) {
    if (d.parentCompanyId === id) return fail("An account can't be its own parent");
    const parent = await db.company.findFirst({ where: { id: d.parentCompanyId, orgId } });
    if (!parent) return fail("Invalid parent account");
    // Walk up the existing chain to catch a 2+ hop cycle (A→B→A).
    let cursor: { id: string; parentCompanyId: string | null } | null = parent;
    while (cursor?.parentCompanyId) {
      if (cursor.parentCompanyId === id) return fail("Parent would create a cycle");
      cursor = await db.company.findUnique({
        where: { id: cursor.parentCompanyId },
        select: { id: true, parentCompanyId: true },
      });
    }
  }

  await db.company.update({
    where: { id },
    data: {
      name: d.name,
      domain: c(d.domain),
      industry: c(d.industry),
      size: c(d.size),
      notes: c(d.notes),
      tier: d.tier ?? existing.tier,
      parentCompanyId: c(d.parentCompanyId),
      arr: d.arr ?? null,
    },
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
