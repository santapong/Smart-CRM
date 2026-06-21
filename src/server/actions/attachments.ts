"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { deleteObject } from "@/lib/storage";

/**
 * Attachment actions (M18). Uploads happen through the /api/files/upload route
 * (it needs the nodejs runtime + multipart parsing); these server actions cover
 * listing and deletion. All reads/writes are org-scoped.
 */

/** The CRM records an attachment can hang off of. */
export type AttachmentEntity = "deal" | "contact" | "company" | "document";

const entitySchema = z.object({
  entity: z.enum(["deal", "contact", "company", "document"]),
  id: z.string().min(1),
});

function whereForEntity(orgId: string, entity: AttachmentEntity, id: string) {
  switch (entity) {
    case "deal":
      return { orgId, dealId: id };
    case "contact":
      return { orgId, contactId: id };
    case "company":
      return { orgId, companyId: id };
    case "document":
      return { orgId, documentId: id };
  }
}

/** List the attachments linked to a single record, newest first. Org-scoped. */
export async function listAttachments(entity: AttachmentEntity, id: string) {
  const parsed = entitySchema.safeParse({ entity, id });
  if (!parsed.success) return [];
  const { orgId } = await requireOrg();
  return db.attachment.findMany({
    where: whereForEntity(orgId, parsed.data.entity, parsed.data.id),
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Delete an attachment (org-scoped). Removes the stored object best-effort first
 * (never throws — see deleteObject), then deletes the row.
 */
export async function deleteAttachment(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const existing = await db.attachment.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  await deleteObject(existing.storageKey);
  await db.attachment.deleteMany({ where: { id, orgId } });
  revalidatePath("/deals");
  if (existing.dealId) revalidatePath(`/deals/${existing.dealId}`);
  return ok({ id });
}
