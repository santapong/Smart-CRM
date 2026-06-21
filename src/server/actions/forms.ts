"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";

// Web forms (M8). `fields` is a JSON array of { key, label, type, required }.
const fieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9_]+$/, "Use letters, numbers and underscores only"),
  label: z.string().trim().min(1).max(120),
  type: z.enum(["text", "email", "tel", "number", "textarea"]).default("text"),
  required: z.boolean().default(false),
});

const formSchema = z.object({
  name: z.string().trim().min(1).max(120),
  fields: z.array(fieldSchema).max(50).default([]),
  target: z.string().max(40).default("lead"),
  pipelineId: z.string().optional().or(z.literal("")),
  redirectUrl: z.string().url().max(2000).optional().or(z.literal("")),
  active: z.boolean().default(true),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function listForms() {
  const { orgId } = await requireOrg();
  return db.form.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function createForm(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const count = await db.form.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "forms", count))) {
    return fail("Plan limit reached: upgrade your plan to add more forms");
  }
  const f = parsed.data;
  const created = await db.form.create({
    data: {
      orgId,
      name: f.name,
      fields: f.fields as unknown as Prisma.InputJsonValue,
      target: f.target,
      pipelineId: c(f.pipelineId),
      redirectUrl: c(f.redirectUrl),
      active: f.active,
    },
  });
  revalidatePath("/forms");
  return ok({ id: created.id });
}

export async function updateForm(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.form.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const f = parsed.data;
  await db.form.update({
    where: { id },
    data: {
      name: f.name,
      fields: f.fields as unknown as Prisma.InputJsonValue,
      target: f.target,
      pipelineId: c(f.pipelineId),
      redirectUrl: c(f.redirectUrl),
      active: f.active,
    },
  });
  revalidatePath("/forms");
  revalidatePath(`/forms/${id}`);
  return ok({ id });
}

export async function deleteForm(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.form.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/forms");
  return ok({ id });
}
