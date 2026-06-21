import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";
import { EnabledToggle } from "./enabled-toggle";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const { orgId } = await requireOrg();
  const workflows = await db.workflow.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <>
      <PageHeader
        title="Automations"
        description="No-code workflows that run when something happens in your CRM."
      >
        <Button asChild>
          <Link href="/automations/new">
            <Plus className="h-4 w-4" /> New automation
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {workflows.length === 0 ? (
          <EmptyState
            title="No automations yet"
            description="Trigger tasks, emails and updates automatically. Start from a recipe or build your own."
            action={
              <Button asChild>
                <Link href="/automations/new">New automation</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Runs</TableHead>
                  <TableHead>Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((w) => {
                  const steps = Array.isArray(w.definition) ? w.definition.length : 0;
                  return (
                    <TableRow key={w.id}>
                      <TableCell>
                        <Link href={`/automations/${w.id}`} className="font-medium hover:underline">
                          {w.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{w.triggerEvent}</TableCell>
                      <TableCell className="text-muted-foreground">{steps}</TableCell>
                      <TableCell className="text-muted-foreground">{w.runCount}</TableCell>
                      <TableCell>
                        <EnabledToggle id={w.id} enabled={w.enabled} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
