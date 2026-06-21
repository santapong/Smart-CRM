import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { LeadForm } from "../lead-form";

export default async function NewLeadPage() {
  const { orgId } = await requireOrg();
  const [contacts, companies] = await Promise.all([
    db.contact.findMany({
      where: { orgId },
      orderBy: { lastName: "asc" },
      select: { id: true, firstName: true, lastName: true },
    }),
    db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return (
    <>
      <PageHeader title="New lead" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <LeadForm
            contacts={contacts.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}` }))}
            companies={companies.map((c) => ({ id: c.id, label: c.name }))}
          />
        </div>
      </div>
    </>
  );
}
