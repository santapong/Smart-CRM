import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const { orgId } = await requireOrg();
  const companies = await db.company.findMany({
    where: { orgId },
    include: { _count: { select: { contacts: true, deals: true } } },
    orderBy: { name: "asc" },
    take: 200,
  });

  return (
    <>
      <PageHeader title="Companies">
        <Button asChild>
          <Link href="/companies/new">
            <Plus className="h-4 w-4" /> New company
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        {companies.length === 0 ? (
          <EmptyState
            title="No companies yet"
            action={
              <Button asChild>
                <Link href="/companies/new">New company</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Domain</TableHead>
                  <TableHead>Industry</TableHead>
                  <TableHead>Contacts</TableHead>
                  <TableHead>Deals</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {companies.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/companies/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.domain ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{c.industry ?? "—"}</TableCell>
                    <TableCell>{c._count.contacts}</TableCell>
                    <TableCell>{c._count.deals}</TableCell>
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
