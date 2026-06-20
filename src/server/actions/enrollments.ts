"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

/**
 * Sequence enrollment actions (M13b). Enrolling a contact or lead into a
 * sequence creates an `active` SequenceEnrollment at step 0, due now — the
 * runner (src/lib/sequences/runner.ts) picks it up on the next cron tick.
 *
 * Any org member may enroll/stop a record (mirrors who can create activities);
 * sequence *authoring* is ADMIN-only (see sequences.ts).
 */

const enrollSchema = z
  .object({
    sequenceId: z.string().min(1),
    contactId: z.string().min(1).optional(),
    leadId: z.string().min(1).optional(),
  })
  .refine((d) => !!d.contactId || !!d.leadId, {
    message: "A contactId or leadId is required",
    path: ["contactId"],
  });

export async function enroll(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = enrollSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const { sequenceId, contactId, leadId } = parsed.data;

  const sequence = await db.sequence.findFirst({ where: { id: sequenceId, orgId } });
  if (!sequence) return fail("Sequence not found");

  // Resolve the recipient (and verify it belongs to the org). We require a
  // deliverable email up front so an enrollment can actually do something.
  let resolvedContactId: string | null = null;
  let resolvedLeadId: string | null = null;
  let email: string | null = null;

  if (contactId) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, orgId },
      select: { id: true, email: true },
    });
    if (!contact) return fail("Contact not found");
    resolvedContactId = contact.id;
    email = contact.email;
  } else if (leadId) {
    const lead = await db.lead.findFirst({
      where: { id: leadId, orgId },
      select: { id: true, contactId: true },
    });
    if (!lead) return fail("Lead not found");
    resolvedLeadId = lead.id;
    if (lead.contactId) {
      const contact = await db.contact.findFirst({
        where: { id: lead.contactId, orgId },
        select: { email: true },
      });
      email = contact?.email ?? null;
    }
  }

  if (!email) return fail("No email address on file for this record");

  // Guard against duplicate active enrollment of the same record in the same
  // sequence.
  const existing = await db.sequenceEnrollment.findFirst({
    where: {
      orgId,
      sequenceId,
      status: "active",
      ...(resolvedContactId ? { contactId: resolvedContactId } : { leadId: resolvedLeadId }),
    },
  });
  if (existing) return fail("This record is already enrolled in that sequence");

  const created = await db.sequenceEnrollment.create({
    data: {
      orgId,
      sequenceId,
      contactId: resolvedContactId,
      leadId: resolvedLeadId,
      status: "active",
      currentStep: 0,
      nextRunAt: new Date(),
    },
  });

  if (resolvedContactId) revalidatePath(`/contacts/${resolvedContactId}`);
  if (resolvedLeadId) revalidatePath(`/leads/${resolvedLeadId}`);
  revalidatePath(`/sequences/${sequenceId}`);
  return ok({ id: created.id });
}

export async function stopEnrollment(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.sequenceEnrollment.updateMany({
    where: { id, orgId, status: "active" },
    data: { status: "stopped", nextRunAt: null },
  });
  if (res.count === 0) return fail("Not found or already stopped");
  return ok({ id });
}
