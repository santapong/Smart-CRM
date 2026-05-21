import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { orgId } = await requireOrg();
  const { q: qParam } = await searchParams;
  const q = qParam?.trim() ?? "";
  const contacts = await db.contact.findMany({
    where: {
      orgId,
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { company: { select: { id: true, name: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 200,
  });

  return (
    <>
      <PageHeader title="Contacts" description="People you work with.">
        <Button asChild>
          <Link href="/contacts/new">
            <Plus className="h-4 w-4" /> New contact
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        <form className="mb-4">
          <input
            type="search"
            name="q"
            placeholder="Search by name or email…"
            defaultValue={q}
            className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
          />
        </form>

        {contacts.length === 0 ? (
          <EmptyState
            title="No contacts yet"
            description="Add your first contact to start building your CRM."
            action={
              <Button asChild>
                <Link href="/contacts/new">New contact</Link>
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Title</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contacts.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/contacts/${c.id}`} className="font-medium hover:underline">
                        {c.firstName} {c.lastName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.email ?? "—"}</TableCell>
                    <TableCell>
                      {c.company ? (
                        <Link href={`/companies/${c.company.id}`} className="hover:underline">
                          {c.company.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.title ?? "—"}</TableCell>
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
