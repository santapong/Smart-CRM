import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { ContactForm } from "../contact-form";

export default async function NewContactPage() {
  const { orgId } = await requireOrg();
  const companies = await db.company.findMany({ where: { orgId }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return (
    <>
      <PageHeader title="New contact" />
      <div className="p-6">
        <div className="max-w-xl rounded-lg border bg-card p-6">
          <ContactForm companies={companies} />
        </div>
      </div>
    </>
  );
}
