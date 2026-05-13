import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { OrgNameForm } from "./org-name-form";
import { MembersSection } from "./members-section";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [org, members] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId } }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (!org) redirect("/login");

  return (
    <>
      <PageHeader title="Settings" description="Manage your workspace and members." />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Organization</h2>
          <OrgNameForm name={org.name} />
        </section>
        <section className="rounded-lg border bg-card p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Members</h2>
          <MembersSection
            members={members.map((m) => ({
              id: m.id,
              role: m.role,
              userId: m.userId,
              email: m.user.email,
              name: m.user.name,
            }))}
          />
        </section>
      </div>
    </>
  );
}
