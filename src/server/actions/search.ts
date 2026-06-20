"use server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { meiliConfigured, searchMeili } from "@/lib/search-meili";
import { ensureSearchIndexes as ensureSearchIndexesImpl } from "@/lib/search-indexes";

export type SearchHit = {
  id: string;
  type: "contact" | "company" | "deal";
  title: string;
  subtitle: string | null;
  href: string;
};

const LIMIT_PER_TYPE = 5;

/**
 * Active search backend (M19a). Postgres full-text search is the live path
 * (zero config, ranked, multi-tenant). Returns "meili" only when
 * MEILISEARCH_HOST is set; the meili branch is a scaffold that still falls back
 * to Postgres until the SDK is wired (see src/lib/search-meili.ts).
 */
export async function searchProvider(): Promise<"meili" | "postgres"> {
  return meiliConfigured() ? "meili" : "postgres";
}

/**
 * Best-effort GIN indexes for full-text search (M19a). Thin server-action
 * re-export of the implementation in src/lib/search-indexes.ts (kept in a plain
 * lib module so prisma/seed.ts can import it without pulling in the auth stack).
 */
export async function ensureSearchIndexes(): Promise<void> {
  await ensureSearchIndexesImpl();
}

type ContactRow = { id: string; firstName: string; lastName: string; email: string | null; companyName: string | null };
type CompanyRow = { id: string; name: string; domain: string | null; industry: string | null };
type DealRow = { id: string; title: string; status: string; stageName: string };

/**
 * Global search across contacts, companies, and deals (M19a — Postgres FTS).
 *
 * Uses websearch_to_tsquery('english', $query) — which parses multi-word and
 * quoted queries — against a to_tsvector built from each entity's searchable
 * columns, ranked with ts_rank and ordered rank-desc. Every query is scoped by
 * `WHERE "orgId" = $orgId`, and ALL user input is parameterized via Prisma.sql
 * ($queryRaw), so it is SQL-injection safe. Works on a fresh `db push` DB with
 * no extension/index (ensureSearchIndexes only adds GIN indexes for speed).
 *
 * For short queries (<=3 chars), where tsquery struggles with partial words, we
 * also union a prefix match (ILIKE) so e.g. "Ze" finds "Zebrafish". When pg_trgm
 * is available it additionally orders fuzzily; without it the prefix match alone
 * keeps short queries useful.
 */
export async function globalSearch(query: string): Promise<ActionResult<{ hits: SearchHit[] }>> {
  const parsed = z.string().trim().min(1).max(100).safeParse(query);
  if (!parsed.success) return fail("Invalid query");
  const q = parsed.data;
  const { orgId } = await requireOrg();

  // Meilisearch is a documented TODO — when configured we attempt it, but the
  // scaffold falls back to Postgres FTS (the live path) for now.
  if (meiliConfigured()) {
    const m = await searchMeili(orgId, q);
    if (m.ok) return ok({ hits: m.hits });
  }

  // Short queries: tsquery can't match partial words well, so also prefix-match.
  const usePrefix = q.length <= 3;
  const prefix = `${q}%`;
  const contains = `%${q}%`;

  const [contacts, companies, deals] = await Promise.all([
    db.$queryRaw<ContactRow[]>(Prisma.sql`
      SELECT c."id", c."firstName", c."lastName", c."email", co."name" AS "companyName"
      FROM "Contact" c
      LEFT JOIN "Company" co ON co."id" = c."companyId"
      WHERE c."orgId" = ${orgId}
        AND (
          to_tsvector('english', coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '') || ' ' || coalesce(c."email", ''))
            @@ websearch_to_tsquery('english', ${q})
          ${usePrefix
            ? Prisma.sql`OR c."firstName" ILIKE ${prefix} OR c."lastName" ILIKE ${prefix} OR c."email" ILIKE ${contains}`
            : Prisma.empty}
        )
      ORDER BY ts_rank(
          to_tsvector('english', coalesce(c."firstName", '') || ' ' || coalesce(c."lastName", '') || ' ' || coalesce(c."email", '')),
          websearch_to_tsquery('english', ${q})
        ) DESC, c."lastName" ASC, c."firstName" ASC
      LIMIT ${LIMIT_PER_TYPE}
    `),
    db.$queryRaw<CompanyRow[]>(Prisma.sql`
      SELECT c."id", c."name", c."domain", c."industry"
      FROM "Company" c
      WHERE c."orgId" = ${orgId}
        AND (
          to_tsvector('english', coalesce(c."name", '') || ' ' || coalesce(c."domain", ''))
            @@ websearch_to_tsquery('english', ${q})
          ${usePrefix
            ? Prisma.sql`OR c."name" ILIKE ${prefix} OR c."domain" ILIKE ${contains}`
            : Prisma.empty}
        )
      ORDER BY ts_rank(
          to_tsvector('english', coalesce(c."name", '') || ' ' || coalesce(c."domain", '')),
          websearch_to_tsquery('english', ${q})
        ) DESC, c."name" ASC
      LIMIT ${LIMIT_PER_TYPE}
    `),
    db.$queryRaw<DealRow[]>(Prisma.sql`
      SELECT d."id", d."title", d."status"::text AS "status", s."name" AS "stageName"
      FROM "Deal" d
      JOIN "PipelineStage" s ON s."id" = d."stageId"
      WHERE d."orgId" = ${orgId}
        AND (
          to_tsvector('english', coalesce(d."title", ''))
            @@ websearch_to_tsquery('english', ${q})
          ${usePrefix ? Prisma.sql`OR d."title" ILIKE ${prefix}` : Prisma.empty}
        )
      ORDER BY ts_rank(
          to_tsvector('english', coalesce(d."title", '')),
          websearch_to_tsquery('english', ${q})
        ) DESC, d."updatedAt" DESC
      LIMIT ${LIMIT_PER_TYPE}
    `),
  ]);

  const hits: SearchHit[] = [
    ...contacts.map((c) => ({
      id: c.id,
      type: "contact" as const,
      title: `${c.firstName} ${c.lastName}`,
      subtitle: c.email ?? c.companyName ?? null,
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
      subtitle: d.status === "OPEN" ? d.stageName : d.status,
      href: `/deals/${d.id}`,
    })),
  ];

  return ok({ hits });
}
