import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { SequenceEnabledToggle } from "../enabled-toggle";
import { StepsEditor } from "./steps-editor";
import { DeleteSequenceButton } from "./delete-button";

export const dynamic = "force-dynamic";

export default async function SequenceDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const sequence = await db.sequence.findFirst({
    where: { id, orgId },
    include: {
      steps: { orderBy: { order: "asc" } },
      _count: { select: { enrollments: true } },
    },
  });
  if (!sequence) notFound();

  const activeCount = await db.sequenceEnrollment.count({
    where: { orgId, sequenceId: id, status: "active" },
  });

  return (
    <>
      <PageHeader
        title={sequence.name}
        description={`${sequence.steps.length} step(s) · ${activeCount} active enrollment(s)`}
      >
        <SequenceEnabledToggle id={sequence.id} enabled={sequence.enabled} />
        <DeleteSequenceButton id={sequence.id} />
      </PageHeader>
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border bg-card p-6">
          <StepsEditor
            sequenceId={sequence.id}
            steps={sequence.steps.map((s) => ({
              id: s.id,
              order: s.order,
              type: s.type,
              subject: s.subject,
              body: s.body,
              waitDays: s.waitDays,
            }))}
          />
        </div>
      </div>
    </>
  );
}
