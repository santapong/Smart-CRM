"use server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

export type SearchHit = {
  id: string;
  type: "contact" | "company" | "deal";
  title: string;
  subtitle: string | null;
  href: string;
};

const LIMIT_PER_TYPE = 5;

export async function globalSearch(query: string): Promise<ActionResult<{ hits: SearchHit[] }>> {
  const parsed = z.string().trim().min(1).max(100).safeParse(query);
  if (!parsed.success) return fail("Invalid query");
  const q = parsed.data;
  const { orgId } = await requireOrg();

  const [contacts, companies, deals] = await Promise.all([
    db.contact.findMany({
      where: {
        orgId,
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      include: { company: { select: { name: true } } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: LIMIT_PER_TYPE,
    }),
    db.company.findMany({
      where: {
        orgId,
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { domain: { contains: q, mode: "insensitive" } },
        ],
      },
      orderBy: { name: "asc" },
      take: LIMIT_PER_TYPE,
    }),
    db.deal.findMany({
      where: { orgId, title: { contains: q, mode: "insensitive" } },
      include: { stage: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: LIMIT_PER_TYPE,
    }),
  ]);

  const hits: SearchHit[] = [
    ...contacts.map((c) => ({
      id: c.id,
      type: "contact" as const,
      title: `${c.firstName} ${c.lastName}`,
      subtitle: c.email ?? c.company?.name ?? null,
      href: `/contacts/${c.id}`,
    })),
    ...companies.map((c) => ({
      id: c.id,
      type: "company" as const,
      title: c.name,
      subtitle: c.domain ?? c.industry ?? null,
      href: `/companies/${c.id}`,
    })),
    ...deals.map((d) => ({
      id: d.id,
      type: "deal" as const,
      title: d.title,
      subtitle: d.status === "OPEN" ? d.stage.name : d.status,
      href: `/deals/${d.id}`,
    })),
  ];

  return ok({ hits });
}
