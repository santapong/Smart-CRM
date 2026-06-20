"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { SCORING_OPS, recomputeAllLeadScores } from "@/lib/scoring";

const ruleBase = z.object({
  entity: z.string().min(1).max(40).default("lead"),
  field: z.string().trim().min(1).max(120),
  op: z.enum(SCORING_OPS),
  value: z.string().max(240).optional().or(z.literal("")),
  points: z.coerce.number().int().min(-1000).max(1000),
});

function requiresValue(d: { op?: string; value?: string }): boolean {
  return d.op === undefined || d.op === "exists" || (d.value !== undefined && d.value !== "");
}
const VALUE_MSG = { message: "A value is required for this operator", path: ["value"] };

const ruleSchema = ruleBase.refine(requiresValue, VALUE_MSG);
const rulePatchSchema = ruleBase.partial().refine(requiresValue, VALUE_MSG);

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createScoringRule(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const d = parsed.data;
  const created = await db.scoringRule.create({
    data: { orgId, entity: d.entity, field: d.field, op: d.op, value: c(d.value), points: d.points },
  });
  if (d.entity === "lead") await recomputeAllLeadScores(orgId);
  revalidatePath("/settings");
  revalidatePath("/leads");
  return ok({ id: created.id });
}

export async function updateScoringRule(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = rulePatchSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const existing = await db.scoringRule.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  await db.scoringRule.update({
    where: { id },
    data: {
      ...(d.entity !== undefined ? { entity: d.entity } : {}),
      ...(d.field !== undefined ? { field: d.field } : {}),
      ...(d.op !== undefined ? { op: d.op } : {}),
      ...(d.value !== undefined ? { value: c(d.value) } : {}),
      ...(d.points !== undefined ? { points: d.points } : {}),
    },
  });
  await recomputeAllLeadScores(orgId);
  revalidatePath("/settings");
  revalidatePath("/leads");
  return ok({ id });
}

export async function deleteScoringRule(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  const res = await db.scoringRule.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  await recomputeAllLeadScores(orgId);
  revalidatePath("/settings");
  revalidatePath("/leads");
  return ok({ id });
}
