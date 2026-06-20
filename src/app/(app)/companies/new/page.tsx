import { requireOrg } from "@/lib/tenant";
import { getDefinitions, toFieldViews } from "@/lib/custom-fields";
import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "../company-form";

export default async function NewCompanyPage() {
  const { orgId } = await requireOrg();
  const defs = await getDefinitions(orgId, "company");
  return (
    <>
      <PageHeader title="New company" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <CompanyForm customFieldDefs={toFieldViews(defs)} />
        </div>
      </div>
    </>
  );
}
