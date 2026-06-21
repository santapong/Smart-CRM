import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { findDuplicates } from "@/lib/merge";
import { db } from "@/lib/db";
import { PageHeader } from "@/components/page-header";
import { DuplicatesSection } from "./duplicates-section";

export const dynamic = "force-dynamic";

export default async function DuplicatesPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [contactGroups, companyGroups, recentMerges] = await Promise.all([
    findDuplicates(orgId, "contact"),
    findDuplicates(orgId, "company"),
    db.mergeLog.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, entity: true, createdAt: true },
    }),
  ]);

  return (
    <>
      <PageHeader title="Duplicates" description="Find and merge duplicate contacts and companies." />
      <div className="p-6">
        <DuplicatesSection
          contactGroups={contactGroups}
          companyGroups={companyGroups}
          recentMerges={recentMerges.map((m) => ({ id: m.id, entity: m.entity, createdAt: m.createdAt.toISOString() }))}
        />
      </div>
    </>
  );
}
