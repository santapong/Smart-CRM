import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { FormEditor } from "../form-editor";
import { EmbedSnippet } from "./embed-snippet";
import type { FormField } from "@/lib/lead-ingest";

export default async function FormDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId } = await requireOrg();
  const [form, submissions] = await Promise.all([
    db.form.findFirst({ where: { id, orgId } }),
    db.formSubmission.findMany({
      where: { orgId, formId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  if (!form) notFound();

  const leadIds = submissions.map((s) => s.leadId).filter((x): x is string => !!x);
  const leads = leadIds.length
    ? await db.lead.findMany({ where: { orgId, id: { in: leadIds } }, select: { id: true, title: true } })
    : [];
  const leadById = new Map(leads.map((l) => [l.id, l]));

  const fields = ((form.fields as unknown as FormField[]) ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    type: (["text", "email", "tel", "number", "textarea"].includes(f.type) ? f.type : "text") as
      | "text"
      | "email"
      | "tel"
      | "number"
      | "textarea",
    required: !!f.required,
  }));

  return (
    <>
      <PageHeader title={form.name} description={`${form.submitCount} submissions`} />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border bg-card p-6">
          <FormEditor
            initial={{ id: form.id, name: form.name, fields, target: form.target, active: form.active }}
          />
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Embed snippet
            </h3>
            <EmbedSnippet formId={form.id} fields={fields} />
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent submissions
            </h3>
            {submissions.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {submissions.map((s) => {
                  const lead = s.leadId ? leadById.get(s.leadId) : undefined;
                  return (
                    <li key={s.id}>
                      {lead ? (
                        <Link href={`/leads/${lead.id}`} className="hover:underline">
                          {lead.title}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">Submission</span>
                      )}
                      <p className="text-xs text-muted-foreground">{s.createdAt.toLocaleString()}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
