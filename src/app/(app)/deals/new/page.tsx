import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { DealForm } from "../deal-form";

export default async function NewDealPage() {
  const { orgId } = await requireOrg();
  const [stages, contacts, companies] = await Promise.all([
    db.pipelineStage.findMany({ where: { orgId }, orderBy: { order: "asc" } }),
    db.contact.findMany({ where: { orgId }, orderBy: { lastName: "asc" }, select: { id: true, firstName: true, lastName: true } }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <>
      <PageHeader title="New deal" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <DealForm
            stages={stages}
            contacts={contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}` }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
          />
        </div>
      </div>
    </>
  );
}
