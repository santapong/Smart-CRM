import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { selectOptions, type CustomFieldEntity, type CustomFieldType } from "@/lib/custom-fields";
import { PageHeader } from "@/components/page-header";
import { OrgNameForm } from "./org-name-form";
import { MembersSection } from "./members-section";
import { CustomFieldsSection } from "./custom-fields-section";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [org, members, fieldDefs] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId } }),
    db.membership.findMany({
      where: { orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.customFieldDefinition.findMany({
      where: { orgId },
      orderBy: [{ entity: "asc" }, { order: "asc" }, { createdAt: "asc" }],
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
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Custom fields</h2>
          <CustomFieldsSection
            definitions={fieldDefs.map((d) => ({
              id: d.id,
              entity: d.entity as CustomFieldEntity,
              key: d.key,
              label: d.label,
              type: d.type as CustomFieldType,
              required: d.required,
              options: selectOptions(d),
            }))}
          />
        </section>
      </div>
    </>
  );
}
