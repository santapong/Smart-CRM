import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { toCsv } from "@/lib/csv";

export const dynamic = "force-dynamic";

export async function GET() {
  let orgId: string;
  try {
    ({ orgId } = await requireOrg());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const contacts = await db.contact.findMany({
    where: { orgId },
    include: {
      company: { select: { name: true } },
      tags: { include: { tag: { select: { name: true } } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const csv = toCsv([
    ["First name", "Last name", "Email", "Phone", "Title", "Company", "Tags", "Notes", "Created"],
    ...contacts.map((c) => [
      c.firstName,
      c.lastName,
      c.email,
      c.phone,
      c.title,
      c.company?.name,
      c.tags.map((t) => t.tag.name).join("; "),
      c.notes,
      c.createdAt.toISOString(),
    ]),
  ]);

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contacts-${stamp}.csv"`,
    },
  });
}
