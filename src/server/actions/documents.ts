"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { withinLimit } from "@/lib/entitlements";
import { emit, EVENTS } from "@/lib/events";
import { renderTemplate, buildMergeContext } from "@/lib/documents";

/**
 * Smart-Docs document + template actions (M18).
 *
 * Templates are ADMIN-gated and capped per plan (withinLimit "documentTemplates",
 * mirroring createPipeline). generateDocument loads the org-scoped entities,
 * builds a merge context (src/lib/documents.ts), renders the body, and persists a
 * Document — emitting EVENTS.DOCUMENT_GENERATED in the same transaction.
 */

const templateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  body: z.string().max(100_000),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

async function requireAdminOrg(): Promise<{ orgId: string; userId: string }> {
  const { orgId, userId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return { orgId, userId };
}

export async function createDocumentTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const count = await db.documentTemplate.count({ where: { orgId } });
  if (!(await withinLimit(orgId, "documentTemplates", count))) {
    return fail("Plan limit reached: upgrade your plan to add more document templates");
  }
  try {
    const created = await db.documentTemplate.create({
      data: {
        orgId,
        name: parsed.data.name,
        description: c(parsed.data.description),
        body: parsed.data.body,
      },
    });
    revalidatePath("/documents");
    return ok({ id: created.id });
  } catch {
    return fail("A template with that name already exists");
  }
}

export async function updateDocumentTemplate(
  id: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const parsed = templateSchema.partial().safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.documentTemplate.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const { name, description, body } = parsed.data;
  try {
    await db.documentTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description: c(description) } : {}),
        ...(body !== undefined ? { body } : {}),
      },
    });
    revalidatePath("/documents");
    return ok({ id });
  } catch {
    return fail("A template with that name already exists");
  }
}

export async function deleteDocumentTemplate(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    ({ orgId } = await requireAdminOrg());
  } catch {
    return fail("Forbidden");
  }
  const res = await db.documentTemplate.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/documents");
  return ok({ id });
}

const generateSchema = z
  .object({
    templateId: z.string().min(1),
    dealId: z.string().optional().or(z.literal("")),
    contactId: z.string().optional().or(z.literal("")),
    companyId: z.string().optional().or(z.literal("")),
    title: z.string().trim().max(200).optional().or(z.literal("")),
  })
  .refine((v) => !!(v.dealId || v.contactId || v.companyId), {
    message: "Pick a deal, contact, or company to generate against",
  });

/**
 * Generate a Document from a template against an org-scoped record. Any/all of
 * deal/contact/company may be supplied; if a deal is given we also resolve its
 * linked contact/company so {{contact.*}}/{{company.*}} fill in automatically.
 */
export async function generateDocument(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = generateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const { templateId } = parsed.data;
  const dealId = c(parsed.data.dealId);
  let contactId = c(parsed.data.contactId);
  let companyId = c(parsed.data.companyId);

  const template = await db.documentTemplate.findFirst({ where: { id: templateId, orgId } });
  if (!template) return fail("Template not found");

  const deal = dealId
    ? await db.deal.findFirst({ where: { id: dealId, orgId }, include: { stage: true } })
    : null;
  if (dealId && !deal) return fail("Deal not found");
  // Fall back to the deal's linked records so contact/company tokens fill in.
  if (deal) {
    contactId = contactId ?? deal.contactId;
    companyId = companyId ?? deal.companyId;
  }

  const [contact, company, org] = await Promise.all([
    contactId ? db.contact.findFirst({ where: { id: contactId, orgId } }) : null,
    companyId ? db.company.findFirst({ where: { id: companyId, orgId } }) : null,
    db.organization.findUnique({ where: { id: orgId }, select: { name: true, slug: true } }),
  ]);
  if (contactId && !contact) return fail("Contact not found");
  if (companyId && !company) return fail("Company not found");

  const context = buildMergeContext({ deal, contact, company, org });
  const content = renderTemplate(template.body, context);
  const title = c(parsed.data.title) ?? template.name;

  const created = await db.$transaction(async (tx) => {
    const doc = await tx.document.create({
      data: {
        orgId,
        templateId: template.id,
        dealId: deal?.id ?? null,
        contactId: contact?.id ?? null,
        companyId: company?.id ?? null,
        title,
        content,
        status: "DRAFT",
        createdById: userId,
      },
    });
    await emit(tx, {
      orgId,
      name: EVENTS.DOCUMENT_GENERATED,
      payload: { documentId: doc.id, templateId: template.id, dealId: doc.dealId },
    });
    return doc;
  });

  revalidatePath("/documents");
  if (deal) revalidatePath(`/deals/${deal.id}`);
  return ok({ id: created.id });
}

export async function deleteDocument(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.document.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/documents");
  return ok({ id });
}
