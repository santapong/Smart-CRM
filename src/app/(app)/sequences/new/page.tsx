import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { NewSequenceForm } from "./new-sequence-form";

export const dynamic = "force-dynamic";

export default async function NewSequencePage() {
  const { role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  return (
    <>
      <PageHeader title="New sequence" description="Name your cadence, then add steps." />
      <div className="p-6">
        <div className="max-w-lg rounded-lg border bg-card p-6">
          <NewSequenceForm />
        </div>
      </div>
    </>
  );
}
