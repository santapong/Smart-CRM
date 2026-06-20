"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";

// Lead labels (M8) — mirrors Tag/ContactTag (src/server/actions/tags.ts).
const labelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #3b82f6")
    .default("#64748b"),
});

export async function createLeadLabel(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = labelSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.leadLabel.findUnique({
    where: { orgId_name: { orgId, name: parsed.data.name } },
  });
  if (existing) return fail("A label with that name already exists");
  const created = await db.leadLabel.create({
    data: { orgId, name: parsed.data.name, color: parsed.data.color },
  });
  revalidatePath("/leads");
  return ok({ id: created.id });
}

export async function deleteLeadLabel(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.leadLabel.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/leads");
  return ok({ id });
}
