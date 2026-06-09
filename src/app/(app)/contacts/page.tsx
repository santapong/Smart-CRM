import Link from "next/link";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { TagBadge } from "@/components/tag-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Download, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const { orgId } = await requireOrg();
  const { q: qParam, tag: tagParam } = await searchParams;
  const q = qParam?.trim() ?? "";
  const tagId = tagParam?.trim() ?? "";

  const [contacts, allTags] = await Promise.all([
    db.contact.findMany({
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
        ...(tagId ? { tags: { some: { tagId } } } : {}),
      },
      include: {
        company: { select: { id: true, name: true } },
        tags: { include: { tag: true } },
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 200,
    }),
    db.tag.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
  ]);

  const filterHref = (id: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (id && id !== tagId) params.set("tag", id);
    const s = params.toString();
    return s ? `/contacts?${s}` : "/contacts";
  };

  return (
    <>
      <PageHeader title="Contacts" description="People you work with.">
        <Button asChild variant="outline">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- file download, must bypass client routing */}
          <a href="/contacts/export">
            <Download className="h-4 w-4" /> Export CSV
          </a>
        </Button>
        <Button asChild>
          <Link href="/contacts/new">
            <Plus className="h-4 w-4" /> New contact
          </Link>
        </Button>
      </PageHeader>
      <div className="p-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <form>
            <input
              type="search"
              name="q"
              placeholder="Search by name or email…"
              defaultValue={q}
              className="h-9 w-72 rounded-md border border-input bg-background px-3 text-sm"
            />
            {tagId && <input type="hidden" name="tag" value={tagId} />}
          </form>
          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {allTags.map((t) => {
                const active = t.id === tagId;
                return (
                  <Link
                    key={t.id}
                    href={filterHref(t.id)}
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                      active ? "" : "text-muted-foreground opacity-60 hover:opacity-100"
                    )}
                    style={
                      active
                        ? { borderColor: t.color, color: t.color, backgroundColor: `${t.color}1a` }
                        : undefined
                    }
                    title={active ? "Clear filter" : `Filter by ${t.name}`}
                  >
                    {t.name}
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {contacts.length === 0 ? (
          <EmptyState
            title={q || tagId ? "No matching contacts" : "No contacts yet"}
            description={
              q || tagId
                ? "Try a different search or clear the tag filter."
                : "Add your first contact to start building your CRM."
            }
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
                  <TableHead>Tags</TableHead>
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
                    <TableCell>
                      {c.tags.length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {c.tags.map((ct) => (
                            <TagBadge key={ct.tagId} name={ct.tag.name} color={ct.tag.color} />
                          ))}
                        </div>
                      )}
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
