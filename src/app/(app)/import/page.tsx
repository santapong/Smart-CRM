import { PageHeader } from "@/components/page-header";
import { requireOrg } from "@/lib/tenant";
import { ImportWizard } from "./import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireOrg();
  return (
    <>
      <PageHeader title="Import" description="Bring contacts or companies in from a CSV file." />
      <div className="p-6">
        <ImportWizard />
      </div>
    </>
  );
}
