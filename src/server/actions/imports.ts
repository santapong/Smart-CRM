"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { inngest } from "@/lib/inngest";
import { parseCsv } from "@/lib/import/parse";
import { processImportJob, suggestMapping, type ImportEntity } from "@/lib/import/runner";

/**
 * Guided CSV import actions (M13c). Members may create import jobs (gated by the
 * `imports` plan limit). Small files are processed inline; larger ones are also
 * enqueued to Inngest (`import/run`) so the request returns quickly. All reads
 * and writes are org-scoped.
 */

const ENTITIES = ["contact", "company"] as const;
const DUPE_MODES = ["skip", "update", "create"] as const;

/** Rows above this run on Inngest instead of inline. */
const INLINE_ROW_LIMIT = 200;

const createSchema = z.object({
  entity: z.enum(ENTITIES),
  fileName: z.string().max(255).optional().or(z.literal("")),
  raw: z.string().min(1, "CSV is empty").max(5_000_000),
  mapping: z.record(z.string()).default({}),
  dupeMode: z.enum(DUPE_MODES).default("skip"),
});

export async function createImportJob(input: unknown): Promise<ActionResult<{ id: string; ran: boolean }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();

  const count = await db.importJob.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "imports", count))) {
    return fail("Plan limit reached: upgrade your plan to run more imports");
  }

  const { headers, rows } = parseCsv(parsed.data.raw);
  if (headers.length === 0) return fail("Could not detect a header row in the CSV");

  const d = parsed.data;
  const job = await db.importJob.create({
    data: {
      orgId,
      entity: d.entity,
      fileName: d.fileName && d.fileName.length > 0 ? d.fileName : null,
      raw: d.raw,
      mapping: d.mapping as Prisma.InputJsonValue,
      dupeMode: d.dupeMode,
      totalRows: rows.length,
      createdById: userId,
    },
  });

  let ran = false;
  if (rows.length <= INLINE_ROW_LIMIT) {
    // Small import — process synchronously so results are ready immediately.
    await processImportJob(job.id);
    ran = true;
  } else {
    // Large import — hand off to Inngest. Defensive: if the event bus is
    // unavailable (e.g. no keys locally), fall back to inline processing so the
    // job never gets stuck pending.
    try {
      await inngest.send({ name: "import/run", data: { jobId: job.id, orgId } });
    } catch {
      await processImportJob(job.id);
      ran = true;
    }
  }

  revalidatePath("/import");
  return ok({ id: job.id, ran });
}

export async function getImportJob(id: string): Promise<
  ActionResult<{
    id: string;
    entity: string;
    status: string;
    fileName: string | null;
    dupeMode: string;
    totalRows: number;
    processed: number;
    created: number;
    updated: number;
    failed: number;
    finishedAt: string | null;
    errors: { rowNumber: number; message: string }[];
  }>
> {
  const { orgId } = await requireOrg();
  const job = await db.importJob.findFirst({
    where: { id, orgId },
    include: { errors: { orderBy: { rowNumber: "asc" }, take: 200 } },
  });
  if (!job) return fail("Not found");
  return ok({
    id: job.id,
    entity: job.entity,
    status: job.status,
    fileName: job.fileName,
    dupeMode: job.dupeMode,
    totalRows: job.totalRows,
    processed: job.processed,
    created: job.created,
    updated: job.updated,
    failed: job.failed,
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    errors: job.errors.map((e) => ({ rowNumber: e.rowNumber, message: e.message })),
  });
}

const previewSchema = z.object({
  entity: z.enum(ENTITIES),
  raw: z.string().min(1).max(5_000_000),
});

export async function previewCsv(input: unknown): Promise<
  ActionResult<{
    headers: string[];
    rows: Record<string, string>[];
    suggestedMapping: Record<string, string>;
  }>
> {
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  await requireOrg();
  const { headers, rows } = parseCsv(parsed.data.raw);
  if (headers.length === 0) return fail("Could not detect a header row in the CSV");
  const suggestedMapping = suggestMapping(parsed.data.entity as ImportEntity, headers);
  return ok({ headers, rows: rows.slice(0, 10), suggestedMapping });
}
