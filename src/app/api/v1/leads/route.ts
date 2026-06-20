import { z } from "zod";
import { db } from "@/lib/db";
import { emit, EVENTS } from "@/lib/events";
import { withinLimit } from "@/lib/entitlements";
import { listCollection, createResource } from "@/lib/api/crud";
import { serializeLead } from "@/lib/api/resources";

/**
 * Public REST API — Leads collection (M12).
 *   GET  /api/v1/leads    list (cursor-paginated, org-scoped)
 *   POST /api/v1/leads    create (idempotent via Idempotency-Key)
 * Scopes: `leads:read` / `leads:write`. Same shape as contacts/deals.
 */

export const runtime = "nodejs";

const LEAD_STATUSES = ["NEW", "WORKING", "QUALIFIED", "UNQUALIFIED", "CONVERTED"] as const;

// Mirrors the server-action lead schema (src/server/actions/leads.ts).
const createSchema = z.object({
  title: z.string().min(1).max(160),
  value: z.coerce.number().min(0).max(1e12).optional(),
  currency: z.string().length(3).default("USD"),
  status: z.enum(LEAD_STATUSES).default("NEW"),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  source: z.string().max(120).optional(),
  sourceChannel: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
});

export async function GET(req: Request): Promise<Response> {
  return listCollection(
    req,
    "leads:read",
    ({ orgId, take, cursor, skip }) =>
      db.lead.findMany({ where: { orgId }, orderBy: { id: "asc" }, take, cursor, skip }),
    serializeLead,
  );
}

export async function POST(req: Request): Promise<Response> {
  return createResource(
    req,
    "leads:write",
    async (auth, body) => {
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return { ok: false as const, message: "Invalid lead payload" };
      const d = parsed.data;
      // Respect the org's plan limit on leads (M4).
      const count = await db.lead.count({ where: { orgId: auth.orgId } });
      if (!(await withinLimit(auth.orgId, "leads", count))) {
        return { ok: false as const, message: "Plan limit reached: upgrade your plan to add more leads" };
      }
      const lead = await db.$transaction(async (tx) => {
        const created = await tx.lead.create({
          data: {
            orgId: auth.orgId,
            title: d.title,
            value: d.value ?? null,
            currency: d.currency,
            status: d.status,
            contactId: d.contactId ?? null,
            companyId: d.companyId ?? null,
            source: d.source ?? null,
            sourceChannel: d.sourceChannel ?? null,
            notes: d.notes ?? null,
          },
        });
        await emit(tx, {
          orgId: auth.orgId,
          name: EVENTS.LEAD_CREATED,
          payload: { leadId: created.id, status: created.status, source: created.source },
        });
        return created;
      });
      return { ok: true as const, row: lead };
    },
    serializeLead,
  );
}
