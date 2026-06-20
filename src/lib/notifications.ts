import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";

/**
 * Notifications (M10). {@link notify} creates an in-app Notification and, when
 * the recipient has an email on file, also records a NotificationDelivery and
 * fires a best-effort, env-gated email (no RESEND_API_KEY → recorded + skipped,
 * never throws). Reads are scoped by org + recipient.
 */

export type NotifyInput = {
  orgId: string;
  recipientId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  actorId?: string | null;
};

/** Create a notification (+ optional email delivery). Returns the new id. */
export async function notify(input: NotifyInput): Promise<{ id: string }> {
  const notification = await db.notification.create({
    data: {
      orgId: input.orgId,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actorId: input.actorId ?? null,
    },
  });

  // Best-effort email delivery when the recipient has an address. Fully
  // env-gated through sendEmail — never throws, so notification creation is
  // never blocked by mail problems.
  const recipient = await db.user.findUnique({
    where: { id: input.recipientId },
    select: { email: true },
  });
  if (recipient?.email) {
    const delivery = await db.notificationDelivery.create({
      data: { notificationId: notification.id, channel: "email", status: "pending" },
    });
    const html = `<p>${escapeHtml(input.title)}</p>${
      input.body ? `<p>${escapeHtml(input.body)}</p>` : ""
    }`;
    const res = await sendEmail({
      orgId: input.orgId,
      to: recipient.email,
      subject: input.title,
      html,
    });
    await db.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: res.status === "sent" ? "sent" : res.status === "failed" ? "failed" : "skipped",
        sentAt: res.status === "sent" ? new Date() : null,
      },
    });
  }

  return { id: notification.id };
}

/** Count of unread notifications for a user in an org. */
export async function getUnreadCount(orgId: string, userId: string): Promise<number> {
  return db.notification.count({ where: { orgId, recipientId: userId, readAt: null } });
}

/** Most-recent notifications for a user in an org (newest first). */
export async function listNotifications(
  orgId: string,
  userId: string,
  opts: { limit?: number } = {},
) {
  return db.notification.findMany({
    where: { orgId, recipientId: userId },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 20,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
