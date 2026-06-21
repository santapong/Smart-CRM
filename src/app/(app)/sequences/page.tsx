import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { hasRole } from "@/lib/rbac";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SequenceEnabledToggle } from "./enabled-toggle";

export const dynamic = "force-dynamic";

export default async function SequencesPage() {
  const { orgId, role } = await requireOrg();
  if (!hasRole(role, "ADMIN")) redirect("/dashboard");

  const sequences = await db.sequence.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { steps: true } },
      enrollments: { where: { status: "active" }, select: { id: true } },
    },
  });

  return (
    <>
      <PageHeader title="Sequences" description="Automated multi-step email & task cadences.">
        <Button asChild size="sm">
          <Link href="/sequences/new">New sequence</Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {sequences.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sequences yet.</p>
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Active enrollments</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sequences.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <Link href={`/sequences/${s.id}`} className="hover:underline">
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{s._count.steps}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{s.enrollments.length}</TableCell>
                    <TableCell>
                      <SequenceEnabledToggle id={s.id} enabled={s.enabled} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/sequences/${s.id}`}>Edit</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  );
}
