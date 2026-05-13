import { PageHeader } from "@/components/page-header";
import { CompanyForm } from "../company-form";

export default function NewCompanyPage() {
  return (
    <>
      <PageHeader title="New company" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <CompanyForm />
        </div>
      </div>
    </>
  );
}
