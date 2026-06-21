import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { NotificationBell } from "@/components/notification-bell";
import { listNotifications, getUnreadCount } from "@/lib/notifications";
import { SessionProvider } from "next-auth/react";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const orgId = session.user.activeOrgId;
  const org = orgId ? await db.organization.findUnique({ where: { id: orgId } }) : null;
  if (!org) redirect("/login?error=no-org");

  const userId = session.user.id;
  const [notifications, unread] = await Promise.all([
    listNotifications(org.id, userId, { limit: 20 }),
    getUnreadCount(org.id, userId),
  ]);

  return (
    <SessionProvider session={session}>
      <div className="flex min-h-screen">
        <AppSidebar orgName={org.name} userEmail={session.user.email ?? ""} />
        <div className="flex flex-1 flex-col overflow-x-hidden">
          <header className="flex items-center justify-end border-b bg-card/30 px-4 py-2">
            <NotificationBell initialItems={notifications} initialUnread={unread} />
          </header>
          <main className="flex-1 overflow-x-hidden">{children}</main>
        </div>
        <CommandPalette />
      </div>
    </SessionProvider>
  );
}
