"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { emit, EVENTS } from "@/lib/events";
import { notify } from "@/lib/notifications";

/**
 * Comments + @mentions (M10). A comment targets one CRM record (contact |
 * company | deal | lead). Mentioning a member fans out a "mention" notification;
 * mentions of non-members are silently ignored. Every create emits a
 * comment.created domain event. All paths are tenant-scoped via requireOrg.
 */

const ENTITY_TYPES = ["contact", "company", "deal", "lead"] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const createSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
  body: z.string().trim().min(1).max(8000),
  mentionedUserIds: z.array(z.string().min(1)).max(50).optional(),
});

/** Verify a record of the given type exists in the org. */
async function entityExists(orgId: string, entityType: EntityType, entityId: string): Promise<boolean> {
  const where = { id: entityId, orgId };
  switch (entityType) {
    case "contact":
      return (await db.contact.count({ where })) > 0;
    case "company":
      return (await db.company.count({ where })) > 0;
    case "deal":
      return (await db.deal.count({ where })) > 0;
    case "lead":
      return (await db.lead.count({ where })) > 0;
  }
}

function entityPath(entityType: EntityType, entityId: string): string {
  return `/${entityType === "company" ? "companies" : `${entityType}s`}/${entityId}`;
}

export async function createComment(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId, userId } = await requireOrg();
  const { entityType, entityId, body } = parsed.data;

  // The target record must belong to the active org (cross-org isolation).
  if (!(await entityExists(orgId, entityType, entityId))) return fail("Not found");

  const comment = await db.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: { orgId, authorId: userId, entityType, entityId, body },
    });
    await emit(tx, {
      orgId,
      name: EVENTS.COMMENT_CREATED,
      payload: { commentId: created.id, entityType, entityId, authorId: userId },
    });
    return created;
  });

  // Fan out mention notifications to members of the org (deduped, excluding the
  // author). Non-members are ignored.
  const mentioned = Array.from(new Set(parsed.data.mentionedUserIds ?? [])).filter(
    (id) => id !== userId,
  );
  if (mentioned.length > 0) {
    const members = await db.membership.findMany({
      where: { orgId, userId: { in: mentioned } },
      select: { userId: true },
    });
    const author = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const actorLabel = author?.name ?? author?.email ?? "Someone";
    for (const m of members) {
      await notify({
        orgId,
        recipientId: m.userId,
        type: "mention",
        title: `${actorLabel} mentioned you`,
        body,
        entityType,
        entityId,
        actorId: userId,
      });
    }
  }

  revalidatePath(entityPath(entityType, entityId));
  return ok({ id: comment.id });
}

export async function deleteComment(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId, role } = await requireOrg();
  const comment = await db.comment.findFirst({ where: { id, orgId } });
  if (!comment) return fail("Not found");
  // Author or an ADMIN/OWNER may delete.
  if (comment.authorId !== userId && role !== "ADMIN" && role !== "OWNER") {
    return fail("Forbidden");
  }
  await db.comment.delete({ where: { id } });
  revalidatePath(entityPath(comment.entityType as EntityType, comment.entityId));
  return ok({ id });
}

export async function listComments(entityType: string, entityId: string) {
  const { orgId } = await requireOrg();
  const parsed = z.enum(ENTITY_TYPES).safeParse(entityType);
  if (!parsed.success) return [];
  return db.comment.findMany({
    where: { orgId, entityType: parsed.data, entityId },
    orderBy: { createdAt: "asc" },
  });
}
