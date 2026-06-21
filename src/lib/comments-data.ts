import { db } from "@/lib/db";
import type { Role } from "@/lib/tenant";
import type { CommentView, Member } from "@/components/comments";

/**
 * Server-side loader for the Comments component (M10). Fetches the org's members
 * (for the @mention picker) and the record's comments with resolved author
 * names + per-row delete permission (author or ADMIN/OWNER).
 */
export async function loadCommentsData(
  orgId: string,
  viewerId: string,
  viewerRole: Role,
  entityType: "contact" | "company" | "deal" | "lead",
  entityId: string,
): Promise<{ members: Member[]; comments: CommentView[] }> {
  const [memberships, comments] = await Promise.all([
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    db.comment.findMany({
      where: { orgId, entityType, entityId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const nameById = new Map(
    memberships.map((m) => [m.user.id, m.user.name ?? m.user.email ?? "Unknown"]),
  );
  const isAdmin = viewerRole === "ADMIN" || viewerRole === "OWNER";

  const members: Member[] = memberships
    .filter((m) => m.user.id !== viewerId)
    .map((m) => ({ userId: m.user.id, name: m.user.name ?? m.user.email ?? "Unknown" }));

  const views: CommentView[] = comments.map((c) => ({
    id: c.id,
    authorId: c.authorId,
    authorName: nameById.get(c.authorId) ?? "Unknown",
    body: c.body,
    createdAt: c.createdAt,
    canDelete: c.authorId === viewerId || isAdmin,
  }));

  return { members, comments: views };
}
