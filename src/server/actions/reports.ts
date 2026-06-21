"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { REPORT_KINDS, runReport, type ReportResult, type ReportSpec } from "@/lib/reports/runners";

/**
 * Report & Dashboard actions (M11). Reads are available to any member; create /
 * update by any member; delete restricted to ADMIN (RBAC). Saved-report and
 * dashboard counts are gated by the `reports` plan limit.
 */

const specSchema = z
  .object({
    pipelineId: z.string().optional().or(z.literal("")).nullable(),
    since: z.string().optional().or(z.literal("")).nullable(),
    until: z.string().optional().or(z.literal("")).nullable(),
    byOwner: z.coerce.boolean().optional(),
  })
  .partial();

const reportSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(REPORT_KINDS),
  spec: specSchema.default({}),
  chartType: z.enum(["bar", "line", "area", "pie"]).default("bar"),
});

function cleanSpec(spec: z.infer<typeof specSchema>): ReportSpec {
  return {
    pipelineId: spec.pipelineId ? spec.pipelineId : null,
    since: spec.since ? spec.since : null,
    until: spec.until ? spec.until : null,
    byOwner: !!spec.byOwner,
  };
}

export async function listReports() {
  const { orgId } = await requireOrg();
  return db.report.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function getReport(id: string) {
  const { orgId } = await requireOrg();
  return db.report.findFirst({ where: { id, orgId } });
}

export async function createReport(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const count = await db.report.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "reports", count))) {
    return fail("Plan limit reached: upgrade your plan to save more reports");
  }
  const d = parsed.data;
  const created = await db.report.create({
    data: {
      orgId,
      name: d.name,
      kind: d.kind,
      chartType: d.chartType,
      spec: cleanSpec(d.spec) as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/reports");
  return ok({ id: created.id });
}

export async function updateReport(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const res = await db.report.updateMany({
    where: { id, orgId },
    data: {
      name: d.name,
      kind: d.kind,
      chartType: d.chartType,
      spec: cleanSpec(d.spec) as unknown as Prisma.InputJsonValue,
    },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  revalidatePath(`/reports/${id}`);
  return ok({ id });
}

export async function deleteReport(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) return fail("Only admins can delete reports");
  const res = await db.report.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  return ok({ id });
}

/** Run a saved report against live data. */
export async function runSavedReport(id: string): Promise<ActionResult<ReportResult>> {
  const { orgId } = await requireOrg();
  const report = await db.report.findFirst({ where: { id, orgId } });
  if (!report) return fail("Not found");
  const kind = report.kind;
  if (!(REPORT_KINDS as readonly string[]).includes(kind)) return fail("Unknown report kind");
  const result = await runReport(orgId, kind as (typeof REPORT_KINDS)[number], (report.spec as ReportSpec) ?? {});
  return ok(result);
}

/** Run an ad-hoc report (report builder preview) without saving. */
export async function runAdHocReport(input: unknown): Promise<ActionResult<ReportResult>> {
  const schema = z.object({ kind: z.enum(REPORT_KINDS), spec: specSchema.default({}) });
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const result = await runReport(orgId, parsed.data.kind, cleanSpec(parsed.data.spec));
  return ok(result);
}

// ---------- Dashboards ----------

const layoutItemSchema = z.object({ reportId: z.string().min(1), position: z.number().int().min(0).default(0) });
const dashboardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  layout: z.array(layoutItemSchema).max(50).default([]),
});

export async function listDashboards() {
  const { orgId } = await requireOrg();
  return db.dashboard.findMany({ where: { orgId }, orderBy: { createdAt: "desc" } });
}

export async function getDashboard(id: string) {
  const { orgId } = await requireOrg();
  return db.dashboard.findFirst({ where: { id, orgId } });
}

export async function createDashboard(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dashboardSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const count = await db.dashboard.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "reports", count))) {
    return fail("Plan limit reached: upgrade your plan to add more dashboards");
  }
  const created = await db.dashboard.create({
    data: {
      orgId,
      name: parsed.data.name,
      layout: parsed.data.layout as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/reports");
  return ok({ id: created.id });
}

export async function updateDashboard(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = dashboardSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const res = await db.dashboard.updateMany({
    where: { id, orgId },
    data: {
      name: parsed.data.name,
      layout: parsed.data.layout as unknown as Prisma.InputJsonValue,
    },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  revalidatePath(`/reports/dashboards/${id}`);
  return ok({ id });
}

export async function deleteDashboard(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) return fail("Only admins can delete dashboards");
  const res = await db.dashboard.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/reports");
  return ok({ id });
}
