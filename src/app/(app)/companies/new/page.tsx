import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "../company-form";

export const dynamic = "force-dynamic";

export default async function NewCompanyPage() {
  const { orgId } = await requireOrg();
  const companies = await db.company.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  return (
    <>
      <PageHeader title="New account" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <CompanyForm companies={companies} />
        </div>
      </div>
    </>
  );
}
