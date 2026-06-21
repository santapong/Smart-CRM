"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { dealRevenue, BILLING_PERIODS, type DealRevenue } from "@/lib/products";

const lineItemSchema = z.object({
  productId: z.string().optional().or(z.literal("")),
  name: z.string().trim().min(1).max(160),
  quantity: z.coerce.number().min(0).max(1e9).default(1),
  unitPrice: z.coerce.number().min(0).max(1e10).default(0),
  discount: z.coerce.number().min(0).max(1e10).optional(),
  billing: z.enum(BILLING_PERIODS).default("one_time"),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

/**
 * Recompute and persist Deal.value from the deal's one-time line items, and
 * return the full revenue breakdown (one-time + MRR/ARR). Runs inside the given
 * tx so it stays atomic with the line-item mutation. When a deal has no line
 * items the stored value is left untouched (preserves manual-value behavior).
 */
async function recomputeDealValue(
  tx: Prisma.TransactionClient,
  orgId: string,
  dealId: string,
): Promise<DealRevenue> {
  const items = await tx.dealProduct.findMany({ where: { orgId, dealId } });
  const revenue = dealRevenue(
    items.map((i) => ({
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discount,
      billing: i.billing,
    })),
  );
  if (items.length > 0) {
    await tx.deal.update({ where: { id: dealId }, data: { value: revenue.oneTime } });
  }
  return revenue;
}

export async function addLineItem(
  dealId: string,
  input: unknown,
): Promise<ActionResult<{ id: string; revenue: DealRevenue }>> {
  const parsed = lineItemSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const deal = await db.deal.findFirst({ where: { id: dealId, orgId } });
  if (!deal) return fail("Deal not found");
  const d = parsed.data;
  const productId = c(d.productId);
  if (productId) {
    const product = await db.product.findFirst({ where: { id: productId, orgId } });
    if (!product) return fail("Product not found");
  }
  const { line, revenue } = await db.$transaction(async (tx) => {
    const line = await tx.dealProduct.create({
      data: {
        orgId,
        dealId,
        productId,
        name: d.name,
        quantity: d.quantity,
        unitPrice: d.unitPrice,
        discount: d.discount ?? null,
        billing: d.billing,
      },
    });
    const revenue = await recomputeDealValue(tx, orgId, dealId);
    return { line, revenue };
  });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  return ok({ id: line.id, revenue });
}

export async function updateLineItem(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string; revenue: DealRevenue }>> {
  const parsed = lineItemSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.dealProduct.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  const revenue = await db.$transaction(async (tx) => {
    await tx.dealProduct.update({
      where: { id },
      data: {
        ...(d.productId !== undefined ? { productId: c(d.productId) } : {}),
        ...(d.name !== undefined ? { name: d.name } : {}),
        ...(d.quantity !== undefined ? { quantity: d.quantity } : {}),
        ...(d.unitPrice !== undefined ? { unitPrice: d.unitPrice } : {}),
        ...(d.discount !== undefined ? { discount: d.discount ?? null } : {}),
        ...(d.billing !== undefined ? { billing: d.billing } : {}),
      },
    });
    return recomputeDealValue(tx, orgId, existing.dealId);
  });
  revalidatePath(`/deals/${existing.dealId}`);
  revalidatePath("/deals");
  return ok({ id, revenue });
}

export async function removeLineItem(
  id: string,
): Promise<ActionResult<{ id: string; revenue: DealRevenue }>> {
  const { orgId } = await requireOrg();
  const existing = await db.dealProduct.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const revenue = await db.$transaction(async (tx) => {
    await tx.dealProduct.delete({ where: { id } });
    return recomputeDealValue(tx, orgId, existing.dealId);
  });
  revalidatePath(`/deals/${existing.dealId}`);
  revalidatePath("/deals");
  return ok({ id, revenue });
}
