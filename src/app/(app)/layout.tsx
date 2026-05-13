import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppSidebar } from "@/components/app-sidebar";
import { SessionProvider } from "next-auth/react";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const orgId = session.user.activeOrgId;
  const org = orgId ? await db.organization.findUnique({ where: { id: orgId } }) : null;
  if (!org) redirect("/login?error=no-org");

  return (
    <SessionProvider session={session}>
      <div className="flex min-h-screen">
        <AppSidebar orgName={org.name} userEmail={session.user.email ?? ""} />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
    </SessionProvider>
  );
}
