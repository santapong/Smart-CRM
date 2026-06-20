"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";

const productSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().max(80).optional().or(z.literal("")),
  unit: z.string().max(40).optional().or(z.literal("")),
  price: z.coerce.number().min(0).max(1e10).default(0),
  cost: z.coerce.number().min(0).max(1e10).optional(),
  currency: z.string().length(3).default("USD"),
  active: z.coerce.boolean().default(true),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = productSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const count = await db.product.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "products", count))) {
    return fail("Plan limit reached: upgrade your plan to add more products");
  }
  const d = parsed.data;
  const created = await db.product.create({
    data: {
      orgId,
      name: d.name,
      sku: c(d.sku),
      unit: c(d.unit),
      price: d.price,
      cost: d.cost ?? null,
      currency: d.currency,
      active: d.active,
    },
  });
  revalidatePath("/products");
  return ok({ id: created.id });
}

export async function updateProduct(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = productSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;
  const res = await db.product.updateMany({
    where: { id, orgId },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.sku !== undefined ? { sku: c(d.sku) } : {}),
      ...(d.unit !== undefined ? { unit: c(d.unit) } : {}),
      ...(d.price !== undefined ? { price: d.price } : {}),
      ...(d.cost !== undefined ? { cost: d.cost ?? null } : {}),
      ...(d.currency !== undefined ? { currency: d.currency } : {}),
      ...(d.active !== undefined ? { active: d.active } : {}),
    },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/products");
  return ok({ id });
}

export async function deleteProduct(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.product.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/products");
  return ok({ id });
}
