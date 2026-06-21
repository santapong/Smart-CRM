import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { FormEditor } from "../form-editor";

export default async function NewFormPage() {
  const { role } = await requireOrg();
  requireRole(role, "ADMIN");
  return (
    <>
      <PageHeader title="New form" />
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border bg-card p-6">
          <FormEditor />
        </div>
      </div>
    </>
  );
}
