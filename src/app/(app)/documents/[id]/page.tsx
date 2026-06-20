import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { esignConfigured } from "@/lib/esign";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { RequestSignature } from "./request-signature";
import { Attachments } from "@/components/documents/attachments";

export const dynamic = "force-dynamic";

export default async function DocumentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, role } = await requireOrg();
  const isAdmin = hasRole(role, "ADMIN");

  const doc = await db.document.findFirst({
    where: { id, orgId },
    include: {
      template: { select: { name: true } },
      deal: { select: { id: true, title: true } },
      signatureRequests: { orderBy: { createdAt: "desc" } },
      attachments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!doc) notFound();

  return (
    <>
      <PageHeader title={doc.title} description={`${doc.status}${doc.template ? ` · from ${doc.template.name}` : ""}`}>
        <Button asChild size="sm" variant="outline">
          <Link href="/documents">Back</Link>
        </Button>
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="rounded-lg border bg-card p-6 lg:col-span-2">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Content</h3>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{doc.content}</pre>
          {doc.deal && (
            <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
              Linked deal:{" "}
              <Link href={`/deals/${doc.deal.id}`} className="hover:underline">
                {doc.deal.title}
              </Link>
            </p>
          )}
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Signatures
            </h3>
            {doc.signatureRequests.length === 0 ? (
              <p className="mb-3 text-sm text-muted-foreground">No signature requests.</p>
            ) : (
              <ul className="mb-3 space-y-2 text-sm">
                {doc.signatureRequests.map((s) => {
                  const signers = Array.isArray(s.signers) ? (s.signers as { email?: string }[]) : [];
                  return (
                    <li key={s.id} className="rounded border p-2">
                      <p className="font-medium">{s.status}</p>
                      <p className="text-xs text-muted-foreground">
                        {signers.map((x) => x.email).filter(Boolean).join(", ") || "—"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
            {isAdmin ? (
              <RequestSignature documentId={doc.id} configured={esignConfigured()} />
            ) : (
              <p className="text-xs text-muted-foreground">Only admins can request signatures.</p>
            )}
          </div>
          <div className="rounded-lg border bg-card p-4">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Attachments
            </h3>
            <Attachments
              entity="document"
              entityId={doc.id}
              attachments={doc.attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                size: a.size,
                storageKey: a.storageKey,
              }))}
            />
          </div>
        </aside>
      </div>
    </>
  );
}
