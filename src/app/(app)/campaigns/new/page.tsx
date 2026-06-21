import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { NewCampaignForm } from "./new-campaign-form";

export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const [tags, companies] = await Promise.all([
    db.tag.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 }),
  ]);

  return (
    <>
      <PageHeader title="New campaign" description="Compose your email and choose who receives it." />
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border bg-card p-6">
          <NewCampaignForm tags={tags} companies={companies} />
        </div>
      </div>
    </>
  );
}
