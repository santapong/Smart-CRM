import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { WorkflowEditor } from "../workflow-editor";
import type { WorkflowAction } from "@/lib/workflows/types";

export const dynamic = "force-dynamic";

export default async function AutomationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");

  const [workflow, recentRuns] = await Promise.all([
    db.workflow.findFirst({ where: { id, orgId } }),
    db.workflowRun.findMany({
      where: { orgId, workflowId: id },
      orderBy: { startedAt: "desc" },
      take: 10,
    }),
  ]);
  if (!workflow) notFound();

  const definition = Array.isArray(workflow.definition)
    ? (workflow.definition as unknown as WorkflowAction[])
    : [];

  return (
    <>
      <PageHeader title={workflow.name} description={`${workflow.runCount} runs`} />
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2 rounded-lg border bg-card p-6">
          <WorkflowEditor
            initial={{
              id: workflow.id,
              name: workflow.name,
              triggerEvent: workflow.triggerEvent,
              conditions: workflow.conditions,
              definition,
              enabled: workflow.enabled,
            }}
          />
        </section>
        <aside className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent runs
          </h3>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {recentRuns.map((run) => (
                <li key={run.id} className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">{run.startedAt.toLocaleString()}</span>
                  <span
                    className={
                      run.status === "failed"
                        ? "text-destructive"
                        : run.status === "done"
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }
                  >
                    {run.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
