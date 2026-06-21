"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { GOAL_METRICS, GOAL_PERIODS, goalProgress, type GoalProgress } from "@/lib/reports/goals";
import type { Goal } from "@prisma/client";

/**
 * Goal actions (M11). Reads (with computed progress) for any member; create /
 * update by any member; delete restricted to ADMIN. Org-scoped throughout.
 */

const goalSchema = z
  .object({
    metric: z.enum(GOAL_METRICS),
    target: z.coerce.number().min(0).max(1e12),
    period: z.enum(GOAL_PERIODS).default("monthly"),
    ownerId: z.string().optional().or(z.literal("")),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
  })
  .refine((d) => new Date(d.endsAt).getTime() > new Date(d.startsAt).getTime(), {
    message: "End must be after start",
    path: ["endsAt"],
  });

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function listGoals(): Promise<Goal[]> {
  const { orgId } = await requireOrg();
  return db.goal.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export type GoalWithProgress = Goal & { progress: GoalProgress };

/** Goals for the active org, each with its current progress computed. */
export async function listGoalsWithProgress(): Promise<GoalWithProgress[]> {
  const { orgId } = await requireOrg();
  const goals = await db.goal.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
  return Promise.all(
    goals.map(async (g) => ({ ...g, progress: await goalProgress(orgId, g) })),
  );
}

export async function createGoal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const created = await db.goal.create({
    data: {
      orgId,
      metric: d.metric,
      target: d.target,
      period: d.period,
      ownerId: c(d.ownerId),
      startsAt: new Date(d.startsAt),
      endsAt: new Date(d.endsAt),
    },
  });
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return ok({ id: created.id });
}

export async function updateGoal(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const res = await db.goal.updateMany({
    where: { id, orgId },
    data: {
      metric: d.metric,
      target: d.target,
      period: d.period,
      ownerId: c(d.ownerId),
      startsAt: new Date(d.startsAt),
      endsAt: new Date(d.endsAt),
    },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return ok({ id });
}

export async function deleteGoal(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) return fail("Only admins can delete goals");
  const res = await db.goal.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  revalidatePath("/dashboard");
  return ok({ id });
}
