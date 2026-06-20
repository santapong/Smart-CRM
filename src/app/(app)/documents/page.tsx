import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { AVAILABLE_MERGE_FIELDS } from "@/lib/documents";
import { PageHeader } from "@/components/page-header";
import { TemplatesSection } from "./templates-section";

export const dynamic = "force-dynamic";

export default async function DocumentsPage() {
  const { orgId, role } = await requireOrg();
  const isAdmin = hasRole(role, "ADMIN");

  const [templates, documents] = await Promise.all([
    db.documentTemplate.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
    db.document.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { template: { select: { name: true } }, deal: { select: { title: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader title="Documents" description="Merge-field templates and the documents generated from them." />
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Templates</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            {isAdmin
              ? "Write a template body and use merge fields like {{deal.title}} or {{contact.fullName}}; they fill in when you generate a document."
              : "Only admins can manage templates."}
          </p>
          <TemplatesSection
            isAdmin={isAdmin}
            mergeFields={AVAILABLE_MERGE_FIELDS}
            templates={templates.map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              body: t.body,
            }))}
          />
        </section>

        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Generated documents
          </h2>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents generated yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <Link href={`/documents/${d.id}`} className="truncate text-sm font-medium hover:underline">
                      {d.title}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {d.status}
                      {d.template ? ` · from ${d.template.name}` : ""}
                      {d.deal ? ` · ${d.deal.title}` : ""} · {d.createdAt.toLocaleDateString()}
                    </p>
                  </div>
                  <Link
                    href={`/documents/${d.id}`}
                    className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    View
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
