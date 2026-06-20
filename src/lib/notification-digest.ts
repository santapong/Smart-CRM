import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";

/**
 * Build and send one email digest per (org, recipient) that has unread
 * notifications. Env-gated through sendEmail — without RESEND_API_KEY this
 * records skipped placeholders and never throws. Returns simple counts so the
 * Inngest job has something to log.
 */
export async function sendNotificationDigests(): Promise<{ users: number; sent: number }> {
  const unread = await db.notification.findMany({
    where: { readAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, orgId: true, recipientId: true, title: true, body: true },
  });

  // Group unread notifications by org + recipient.
  const groups = new Map<string, { orgId: string; recipientId: string; titles: string[] }>();
  for (const n of unread) {
    const key = `${n.orgId}:${n.recipientId}`;
    const g = groups.get(key) ?? { orgId: n.orgId, recipientId: n.recipientId, titles: [] };
    if (g.titles.length < 20) g.titles.push(n.title);
    groups.set(key, g);
  }

  let sent = 0;
  for (const g of groups.values()) {
    const user = await db.user.findUnique({ where: { id: g.recipientId }, select: { email: true } });
    if (!user?.email) continue;
    const items = g.titles.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
    await sendEmail({
      orgId: g.orgId,
      to: user.email,
      subject: `You have ${g.titles.length} unread notification${g.titles.length === 1 ? "" : "s"}`,
      html: `<p>Here's what you missed:</p><ul>${items}</ul>`,
    });
    sent += 1;
  }

  return { users: groups.size, sent };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
