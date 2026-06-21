import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function FormsPage() {
  const { orgId } = await requireOrg();
  const forms = await db.form.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { submissions: true } } },
  });

  return (
    <>
      <PageHeader title="Forms" description="Public web forms that capture leads.">
        <Button asChild>
          <Link href="/forms/new">
            <Plus className="h-4 w-4" /> New form
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {forms.length === 0 ? (
          <EmptyState
            title="No forms yet"
            description="Create a web form and embed it on your site to capture leads."
            action={
              <Button asChild>
                <Link href="/forms/new">New form</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Submissions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forms.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <Link href={`/forms/${f.id}`} className="font-medium hover:underline">
                        {f.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.target}</TableCell>
                    <TableCell className="text-muted-foreground">{f.active ? "Active" : "Inactive"}</TableCell>
                    <TableCell className="text-muted-foreground">{f._count.submissions}</TableCell>
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
