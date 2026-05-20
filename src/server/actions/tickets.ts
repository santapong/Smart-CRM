"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const ticketStatus = z.enum(["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]);
const ticketPriority = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);

const createSchema = z.object({
  companyId: z.string().min(1),
  contactId: z.string().optional().or(z.literal("")),
  assigneeId: z.string().optional().or(z.literal("")),
  subject: z.string().min(1).max(200),
  body: z.string().max(8000).optional().or(z.literal("")),
  priority: ticketPriority.default("NORMAL"),
});

const updateSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().max(8000).optional().or(z.literal("")),
  status: ticketStatus,
  priority: ticketPriority,
  assigneeId: z.string().optional().or(z.literal("")),
  contactId: z.string().optional().or(z.literal("")),
});

const clean = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createTicket(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  const company = await db.company.findFirst({ where: { id: d.companyId, orgId } });
  if (!company) return fail("Account not found");
  if (d.contactId) {
    const contact = await db.contact.findFirst({ where: { id: d.contactId, orgId } });
    if (!contact) return fail("Contact not found");
  }
  if (d.assigneeId) {
    const membership = await db.membership.findFirst({ where: { userId: d.assigneeId, orgId } });
    if (!membership) return fail("Assignee is not a member of this organization");
  }

  const created = await db.ticket.create({
    data: {
      orgId,
      companyId: d.companyId,
      contactId: clean(d.contactId),
      assigneeId: clean(d.assigneeId),
      subject: d.subject,
      body: clean(d.body),
      priority: d.priority,
    },
  });

  revalidatePath("/tickets");
  revalidatePath(`/companies/${d.companyId}`);
  return ok({ id: created.id });
}

export async function updateTicket(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.ticket.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;

  if (d.contactId) {
    const contact = await db.contact.findFirst({ where: { id: d.contactId, orgId } });
    if (!contact) return fail("Contact not found");
  }
  if (d.assigneeId) {
    const membership = await db.membership.findFirst({ where: { userId: d.assigneeId, orgId } });
    if (!membership) return fail("Assignee is not a member of this organization");
  }

  // Status transitions stamp the corresponding timestamp once.
  const now = new Date();
  const patch: {
    subject: string;
    body: string | null;
    status: typeof d.status;
    priority: typeof d.priority;
    contactId: string | null;
    assigneeId: string | null;
    resolvedAt?: Date | null;
    closedAt?: Date | null;
  } = {
    subject: d.subject,
    body: clean(d.body),
    status: d.status,
    priority: d.priority,
    contactId: clean(d.contactId),
    assigneeId: clean(d.assigneeId),
  };
  if (d.status === "RESOLVED" && !existing.resolvedAt) patch.resolvedAt = now;
  if (d.status === "CLOSED" && !existing.closedAt) patch.closedAt = now;
  if (d.status !== "RESOLVED" && d.status !== "CLOSED") {
    // Re-opening clears resolution timestamps so SLA can recompute properly.
    patch.resolvedAt = null;
    patch.closedAt = null;
  }

  await db.ticket.update({ where: { id }, data: patch });

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${id}`);
  revalidatePath(`/companies/${existing.companyId}`);
  return ok({ id });
}

export async function markTicketFirstResponse(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const existing = await db.ticket.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  if (existing.firstResponseAt) return ok({ id });
  await db.ticket.update({ where: { id }, data: { firstResponseAt: new Date() } });
  revalidatePath(`/tickets/${id}`);
  revalidatePath(`/companies/${existing.companyId}`);
  return ok({ id });
}

export async function deleteTicket(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const existing = await db.ticket.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  await db.ticket.delete({ where: { id } });
  revalidatePath("/tickets");
  revalidatePath(`/companies/${existing.companyId}`);
  return ok({ id });
}
