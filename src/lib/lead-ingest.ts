import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emit, EVENTS } from "@/lib/events";

/**
 * Shared public-form ingest logic (M8). Used by the public submit route
 * (src/app/api/forms/[id]/submit/route.ts) and unit-tested directly.
 *
 * Given a form and a submission payload it:
 *  - dedupes by email within the org (reuses an existing Contact/Lead)
 *  - creates a Lead (unless an open lead with that email already exists)
 *  - records a FormSubmission, emits FORM_SUBMITTED, bumps form.submitCount
 * All writes are atomic and org-scoped.
 */

export type FormField = { key: string; label: string; type: string; required?: boolean };

export type IngestForm = {
  id: string;
  orgId: string;
  name: string;
  fields: FormField[];
  active: boolean;
};

/** Pull the first email-looking value out of the submitted data. */
export function pickEmail(
  fields: FormField[],
  data: Record<string, unknown>,
): string | null {
  // Prefer an explicit email-typed field, else any field named "email".
  const emailKey =
    fields.find((f) => f.type === "email")?.key ??
    fields.find((f) => f.key.toLowerCase() === "email")?.key ??
    "email";
  const raw = data[emailKey];
  if (typeof raw === "string" && raw.includes("@")) return raw.trim().toLowerCase();
  return null;
}

/** Build a human title for the lead from the submission. */
function deriveTitle(form: IngestForm, data: Record<string, unknown>, email: string | null): string {
  const name = data["name"] ?? data["fullName"] ?? data["full_name"];
  if (typeof name === "string" && name.trim()) return name.trim();
  if (email) return email;
  return `${form.name} submission`;
}

export type IngestResult = {
  leadId: string;
  submissionId: string;
  contactId: string | null;
  deduped: boolean;
};

export async function ingestFormSubmission(opts: {
  form: IngestForm;
  data: Record<string, unknown>;
  utm?: Record<string, unknown> | null;
}): Promise<IngestResult> {
  const { form, data, utm } = opts;
  const orgId = form.orgId;
  const email = pickEmail(form.fields, data);

  // Dedupe by email within the org: reuse an existing contact, and avoid
  // creating a second open lead for the same person.
  const existingContact = email
    ? await db.contact.findFirst({ where: { orgId, email } })
    : null;

  const existingLead = email
    ? await db.lead.findFirst({
        where: {
          orgId,
          status: { not: "CONVERTED" },
          contactId: existingContact ? existingContact.id : undefined,
        },
        orderBy: { createdAt: "desc" },
      })
    : null;

  const notesParts = Object.entries(data)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

  return db.$transaction(async (tx) => {
    let leadId: string;
    let deduped = false;

    if (existingLead) {
      // Reuse the existing open lead — just record the new submission against it.
      leadId = existingLead.id;
      deduped = true;
    } else {
      const lead = await tx.lead.create({
        data: {
          orgId,
          title: deriveTitle(form, data, email),
          status: "NEW",
          source: form.name,
          sourceChannel: "web_form",
          contactId: existingContact ? existingContact.id : null,
          utm: (utm ?? undefined) as Prisma.InputJsonValue | undefined,
          notes: notesParts.length > 0 ? notesParts.join("\n") : null,
        },
      });
      leadId = lead.id;
      await emit(tx, {
        orgId,
        name: EVENTS.LEAD_CREATED,
        payload: { leadId, source: form.name, channel: "web_form" },
      });
    }

    const submission = await tx.formSubmission.create({
      data: {
        orgId,
        formId: form.id,
        leadId,
        data: data as Prisma.InputJsonValue,
        utm: (utm ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });

    await tx.form.update({ where: { id: form.id }, data: { submitCount: { increment: 1 } } });

    await emit(tx, {
      orgId,
      name: EVENTS.FORM_SUBMITTED,
      payload: { formId: form.id, submissionId: submission.id, leadId, deduped },
    });

    return {
      leadId,
      submissionId: submission.id,
      contactId: existingContact ? existingContact.id : null,
      deduped,
    };
  });
}
