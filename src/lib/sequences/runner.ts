import type { SequenceEnrollment, SequenceStep } from "@prisma/client";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { genericMessage } from "@/lib/email-templates";

/**
 * Sales sequence runner (M13b).
 *
 * {@link processDueEnrollments} is driven by an Inngest cron. For each active
 * enrollment whose `nextRunAt` is due, it executes the current step and advances:
 *
 * - `email` → resolves the enrollee's address and sends via {@link sendEmail}
 *   (env-gated: recorded + skipped offline, never throws), then advances and
 *   schedules the next step to run on the next tick (`nextRunAt = now`).
 * - `task`  → creates a TASK Activity linked to the contact (and, for a lead,
 *   carries the enrollment forward), then advances (`nextRunAt = now`).
 * - `wait`  → schedules the NEXT step `waitDays` in the future and advances.
 *
 * When `currentStep` moves past the last step the enrollment is marked
 * `completed`. The whole thing is defensive: a step that throws sets `lastError`
 * and reschedules with a short backoff — it never throws into the loop, so one
 * bad enrollment can't break the batch.
 */

const DAY_MS = 86_400_000;
/** Backoff before retrying a failed step (5 minutes). */
const RETRY_BACKOFF_MS = 5 * 60_000;

type Recipient = {
  email: string | null;
  contactId: string | null;
};

/** Resolve the recipient email + linked contact for an enrollment. */
async function resolveRecipient(enrollment: SequenceEnrollment): Promise<Recipient> {
  if (enrollment.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: enrollment.contactId, orgId: enrollment.orgId },
      select: { id: true, email: true },
    });
    return { email: contact?.email ?? null, contactId: contact?.id ?? null };
  }
  if (enrollment.leadId) {
    const lead = await db.lead.findFirst({
      where: { id: enrollment.leadId, orgId: enrollment.orgId },
      select: { contactId: true },
    });
    if (lead?.contactId) {
      const contact = await db.contact.findFirst({
        where: { id: lead.contactId, orgId: enrollment.orgId },
        select: { id: true, email: true },
      });
      return { email: contact?.email ?? null, contactId: contact?.id ?? null };
    }
  }
  return { email: null, contactId: null };
}

/**
 * Execute a single step for one enrollment and persist the resulting state.
 * Never throws — failures set `lastError` and reschedule with backoff.
 */
async function runStep(
  enrollment: SequenceEnrollment,
  step: SequenceStep,
  totalSteps: number,
): Promise<"advanced" | "waiting" | "failed"> {
  const now = new Date();
  // Whether this is the last step; once we run past it the enrollment completes.
  const isLast = enrollment.currentStep >= totalSteps - 1;

  try {
    if (step.type === "wait") {
      // A wait gates the NEXT step: advance the pointer but defer nextRunAt.
      const days = Math.max(0, step.waitDays);
      await db.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStep: enrollment.currentStep + 1,
          status: isLast ? "completed" : "active",
          nextRunAt: isLast ? null : new Date(now.getTime() + days * DAY_MS),
          lastError: null,
        },
      });
      return isLast ? "advanced" : "waiting";
    }

    if (step.type === "email") {
      const { email, contactId } = await resolveRecipient(enrollment);
      if (email) {
        const { subject, html } = genericMessage({
          subject: step.subject?.slice(0, 200) || "Message",
          body: step.body ?? "",
        });
        await sendEmail({
          orgId: enrollment.orgId,
          to: email,
          subject,
          html,
          contactId,
        });
      }
      // Advance regardless (a missing address shouldn't stall the cadence).
    } else if (step.type === "task") {
      const { contactId } = await resolveRecipient(enrollment);
      await db.activity.create({
        data: {
          orgId: enrollment.orgId,
          type: "TASK",
          title: step.subject?.slice(0, 160) || "Sequence task",
          body: step.body ?? null,
          contactId,
        },
      });
    }
    // Unknown step types are skipped (advanced) defensively.

    await db.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        currentStep: enrollment.currentStep + 1,
        status: isLast ? "completed" : "active",
        // Non-wait steps run the next step on the following tick.
        nextRunAt: isLast ? null : now,
        lastError: null,
      },
    });
    return "advanced";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.sequenceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        lastError: message.slice(0, 500),
        nextRunAt: new Date(now.getTime() + RETRY_BACKOFF_MS),
      },
    });
    return "failed";
  }
}

/**
 * Process up to `limit` active enrollments whose `nextRunAt` is due. Returns
 * counts of work done. Safe to run with no API keys (email sends are no-ops).
 */
export async function processDueEnrollments(
  limit = 50,
): Promise<{ processed: number; advanced: number; waiting: number; completed: number; failed: number }> {
  const now = new Date();
  const due = await db.sequenceEnrollment.findMany({
    where: { status: "active", nextRunAt: { not: null, lte: now } },
    orderBy: { nextRunAt: "asc" },
    take: limit,
  });

  let advanced = 0;
  let waiting = 0;
  let completed = 0;
  let failed = 0;

  for (const enrollment of due) {
    // Defensive: load the sequence + its steps. A disabled or deleted sequence
    // stops the enrollment cleanly.
    const sequence = await db.sequence.findFirst({
      where: { id: enrollment.sequenceId, orgId: enrollment.orgId },
      include: { steps: { orderBy: { order: "asc" } } },
    });
    if (!sequence || !sequence.enabled) {
      await db.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "stopped", nextRunAt: null },
      });
      continue;
    }

    const steps = sequence.steps;
    if (enrollment.currentStep >= steps.length) {
      await db.sequenceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "completed", nextRunAt: null },
      });
      completed += 1;
      continue;
    }

    const step = steps[enrollment.currentStep];
    const outcome = await runStep(enrollment, step, steps.length);
    if (outcome === "advanced") {
      advanced += 1;
      // Mark completed tally when the pointer moved past the last step.
      if (enrollment.currentStep + 1 >= steps.length) completed += 1;
    } else if (outcome === "waiting") {
      waiting += 1;
    } else {
      failed += 1;
    }
  }

  return { processed: due.length, advanced, waiting, completed, failed };
}
