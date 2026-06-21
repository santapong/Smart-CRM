import { z } from "zod";
import { db } from "@/lib/db";
import { gate } from "@/lib/api/crud";
import { apiOk, apiError } from "@/lib/api/respond";
import { serializeLead } from "@/lib/api/resources";

/**
 * Public REST API — single Lead (M12).
 *   GET / PATCH / DELETE /api/v1/leads/[id]
 * Org-scoped. See the collection route for the shared pattern.
 */

export const runtime = "nodejs";

const LEAD_STATUSES = ["NEW", "WORKING", "QUALIFIED", "UNQUALIFIED", "CONVERTED"] as const;

const patchSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    value: z.coerce.number().min(0).max(1e12).nullable().optional(),
    currency: z.string().length(3).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    contactId: z.string().nullable().optional(),
    companyId: z.string().nullable().optional(),
    source: z.string().max(120).nullable().optional(),
    sourceChannel: z.string().max(120).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "leads:read");
  if (g.response) return g.response;
  const { id } = await params;
  const lead = await db.lead.findFirst({ where: { id, orgId: g.auth.orgId } });
  if (!lead) return apiError("not_found", "Lead not found");
  return apiOk(serializeLead(lead));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "leads:write");
  if (g.response) return g.response;
  const { id } = await params;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_request", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError("invalid_request", "Invalid lead payload");

  const existing = await db.lead.findFirst({ where: { id, orgId: g.auth.orgId } });
  if (!existing) return apiError("not_found", "Lead not found");

  const updated = await db.lead.update({
    where: { id },
    data: { ...parsed.data, version: { increment: 1 } },
  });
  return apiOk(serializeLead(updated));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "leads:write");
  if (g.response) return g.response;
  const { id } = await params;
  const res = await db.lead.deleteMany({ where: { id, orgId: g.auth.orgId } });
  if (res.count === 0) return apiError("not_found", "Lead not found");
  return apiOk({ id, deleted: true });
}
