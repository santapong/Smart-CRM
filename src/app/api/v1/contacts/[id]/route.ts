import { z } from "zod";
import { db } from "@/lib/db";
import { gate } from "@/lib/api/crud";
import { apiOk, apiError } from "@/lib/api/respond";
import { serializeContact } from "@/lib/api/resources";

/**
 * Public REST API — single Contact (M12).
 *   GET / PATCH / DELETE /api/v1/contacts/[id]
 * Every query is scoped by the API key's orgId. See the collection route for
 * the overall pattern (companies/activities mirror it).
 */

export const runtime = "nodejs";

const patchSchema = z
  .object({
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    title: z.string().max(80).nullable().optional(),
    companyId: z.string().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
  })
  .strict();

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "contacts:read");
  if (g.response) return g.response;
  const { id } = await params;
  const contact = await db.contact.findFirst({ where: { id, orgId: g.auth.orgId } });
  if (!contact) return apiError("not_found", "Contact not found");
  return apiOk(serializeContact(contact));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "contacts:write");
  if (g.response) return g.response;
  const { id } = await params;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_request", "Request body must be valid JSON");
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return apiError("invalid_request", "Invalid contact payload");

  const existing = await db.contact.findFirst({ where: { id, orgId: g.auth.orgId } });
  if (!existing) return apiError("not_found", "Contact not found");

  const updated = await db.contact.update({
    where: { id },
    data: { ...parsed.data, version: { increment: 1 } },
  });
  return apiOk(serializeContact(updated));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await gate(req, "contacts:write");
  if (g.response) return g.response;
  const { id } = await params;
  const res = await db.contact.deleteMany({ where: { id, orgId: g.auth.orgId } });
  if (res.count === 0) return apiError("not_found", "Contact not found");
  return apiOk({ id, deleted: true });
}
