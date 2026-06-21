"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { emit, EVENTS } from "@/lib/events";
import { sendEmail } from "@/lib/email";
import { genericMessage } from "@/lib/email-templates";

const sendTrackedEmailSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    dealId: z.string().min(1).optional(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
  })
  .refine((d) => !!d.contactId || !!d.dealId, {
    message: "A contactId or dealId is required",
    path: ["contactId"],
  });

/**
 * Send a tracked, org-scoped email from a contact or deal record (M7). Resolves
 * the recipient from the record's contact email, records + sends via
 * {@link sendEmail} (skipped offline, never throws), and emits `email.sent`.
 */
export async function sendTrackedEmail(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  const parsed = sendTrackedEmailSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const { contactId, dealId, subject, body } = parsed.data;

  // Resolve the recipient + the record this email belongs to, all org-scoped.
  let toAddr: string | null = null;
  let resolvedContactId: string | null = null;
  let resolvedDealId: string | null = null;

  if (dealId) {
    const deal = await db.deal.findFirst({
      where: { id: dealId, orgId },
      include: { contact: { select: { id: true, email: true } } },
    });
    if (!deal) return fail("Deal not found");
    resolvedDealId = deal.id;
    resolvedContactId = deal.contact?.id ?? null;
    toAddr = deal.contact?.email ?? null;
  } else if (contactId) {
    const contact = await db.contact.findFirst({
      where: { id: contactId, orgId },
      select: { id: true, email: true },
    });
    if (!contact) return fail("Contact not found");
    resolvedContactId = contact.id;
    toAddr = contact.email;
  }

  if (!toAddr) return fail("No email address on file for this record");

  const { subject: subj, html } = genericMessage({ subject, body });

  const result = await sendEmail({
    orgId,
    to: toAddr,
    subject: subj,
    html,
    contactId: resolvedContactId,
    dealId: resolvedDealId,
    sentById: userId,
  });

  await db.$transaction(async (tx) => {
    await emit(tx, {
      orgId,
      name: EVENTS.EMAIL_SENT,
      payload: {
        emailMessageId: result.id,
        contactId: resolvedContactId,
        dealId: resolvedDealId,
        status: result.status,
      },
    });
  });

  if (resolvedContactId) revalidatePath(`/contacts/${resolvedContactId}`);
  if (resolvedDealId) revalidatePath(`/deals/${resolvedDealId}`);

  return ok({ id: result.id, status: result.status });
}
