import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emit, EVENTS } from "@/lib/events";
import { listCollection, createResource } from "@/lib/api/crud";
import { serializeContact } from "@/lib/api/resources";

/**
 * Public REST API — Contacts collection (M12).
 *
 *   GET  /api/v1/contacts        list (cursor-paginated, org-scoped)
 *   POST /api/v1/contacts        create (idempotent via Idempotency-Key)
 *
 * API-key auth + scopes (`contacts:read` / `contacts:write`) and per-key rate
 * limiting are applied in the shared crud helpers. Companies and activities
 * follow this exact same pattern (collection + [id] route, scope per resource).
 */

export const runtime = "nodejs";

// Mirrors the server-action contact schema (src/server/actions/contacts.ts).
const createSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  title: z.string().max(80).optional(),
  companyId: z.string().optional(),
  notes: z.string().max(4000).optional(),
});

export async function GET(req: Request): Promise<Response> {
  return listCollection(
    req,
    "contacts:read",
    ({ orgId, take, cursor, skip }) =>
      db.contact.findMany({ where: { orgId }, orderBy: { id: "asc" }, take, cursor, skip }),
    serializeContact,
  );
}

export async function POST(req: Request): Promise<Response> {
  return createResource(
    req,
    "contacts:write",
    async (auth, body) => {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return { ok: false as const, message: "Invalid contact payload" };
      const d = parsed.data;
      const contact = await db.$transaction(async (tx) => {
        const c = await tx.contact.create({
          data: {
            orgId: auth.orgId,
            firstName: d.firstName,
            lastName: d.lastName,
            email: d.email ?? null,
            phone: d.phone ?? null,
            title: d.title ?? null,
            companyId: d.companyId ?? null,
            notes: d.notes ?? null,
            customFields: Prisma.JsonNull,
          },
        });
        await emit(tx, { orgId: auth.orgId, name: EVENTS.CONTACT_CREATED, payload: { contactId: c.id } });
        return c;
      });
      return { ok: true as const, row: contact };
    },
    serializeContact,
  );
}
