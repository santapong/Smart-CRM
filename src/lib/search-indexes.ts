import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

type DbClient = Pick<PrismaClient, "$executeRaw">;

/**
 * Best-effort GIN indexes for Postgres full-text search (M19a).
 *
 * Runs `CREATE INDEX IF NOT EXISTS ... USING gin (to_tsvector('english', ...))`
 * over each searchable table — purely a performance optimization. Search
 * CORRECTNESS does NOT depend on these (to_tsvector / websearch_to_tsquery work
 * on a fresh `db push` DB with zero DDL), so every statement is wrapped in
 * try/catch: a failure (e.g. insufficient privileges) is swallowed and never
 * breaks search. Called best-effort from prisma/seed.ts so dev/CI DBs get the
 * indexes; the app never hard-depends on them.
 *
 * Also best-effort-enables the pg_trgm extension so the fuzzy/prefix fallback in
 * globalSearch can use trigram ordering when available — but FTS-only works
 * without it, so a failed CREATE EXTENSION is likewise swallowed.
 *
 * Accepts a Prisma client (defaults to the shared `db`) so the seed can pass its
 * own instance.
 */
export async function ensureSearchIndexes(client: DbClient = db): Promise<void> {
  const statements: Prisma.Sql[] = [
    // Optional enhancement — trigram fuzzy matching. If the role can't CREATE
    // EXTENSION, FTS-only still works.
    Prisma.sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`,
    Prisma.sql`CREATE INDEX IF NOT EXISTS "Contact_fts_idx" ON "Contact" USING gin (to_tsvector('english', coalesce("firstName", '') || ' ' || coalesce("lastName", '') || ' ' || coalesce("email", '')))`,
    Prisma.sql`CREATE INDEX IF NOT EXISTS "Company_fts_idx" ON "Company" USING gin (to_tsvector('english', coalesce("name", '') || ' ' || coalesce("domain", '')))`,
    Prisma.sql`CREATE INDEX IF NOT EXISTS "Deal_fts_idx" ON "Deal" USING gin (to_tsvector('english', coalesce("title", '')))`,
  ];
  for (const sql of statements) {
    try {
      await client.$executeRaw(sql);
    } catch {
      // Swallow — indexes/extensions are an optimization, never a dependency.
    }
  }
}
