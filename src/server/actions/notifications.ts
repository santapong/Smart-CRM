"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { listNotifications, getUnreadCount } from "@/lib/notifications";

/**
 * In-app notification actions (M10). All org + recipient scoped via requireOrg
 * so a user can only ever see/mutate their own notifications in the active org.
 */

export async function listMyNotifications(limit = 20) {
  const { orgId, userId } = await requireOrg();
  const [items, unread] = await Promise.all([
    listNotifications(orgId, userId, { limit }),
    getUnreadCount(orgId, userId),
  ]);
  return { items, unread };
}

export async function markNotificationRead(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId, userId } = await requireOrg();
  const res = await db.notification.updateMany({
    where: { id, orgId, recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/");
  return ok({ id });
}

export async function markAllRead(): Promise<ActionResult<{ count: number }>> {
  const { orgId, userId } = await requireOrg();
  const res = await db.notification.updateMany({
    where: { orgId, recipientId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/");
  return ok({ count: res.count });
}
