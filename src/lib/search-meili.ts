/**
 * Meilisearch adapter (M19a) — env-gated scaffold, no heavy deps.
 *
 * The live search path is Postgres full-text search (see src/server/actions/search.ts),
 * which needs zero config and stays multi-tenant + ranked on a fresh DB. A hosted
 * Meilisearch instance is a drop-in upgrade for typo-tolerance and faster fan-out,
 * but it needs its own service + SDK. To keep the build/tests green with zero extra
 * infra and no keys we DO NOT install that package here (mirrors the SSO scaffold in
 * M16 and the eSign scaffold in M18). Instead:
 *  - {@link meiliConfigured} reports whether MEILISEARCH_HOST is set.
 *  - {@link searchMeili} returns a not-configured result and makes NO network call,
 *    so globalSearch can fall back to Postgres FTS.
 *
 * TODO: wire Meilisearch — install the SDK, build a MeiliSearch client from
 * MEILISEARCH_HOST/MEILISEARCH_KEY, index contacts/companies/deals per org (filter
 * on orgId so tenants stay isolated), and map the multi-search hits to SearchHit.
 */
import type { SearchHit } from "@/server/actions/search";

/** Shared "Meilisearch is not configured" sentinel. */
export const MEILI_NOT_CONFIGURED = "Meilisearch is not configured" as const;

/** True when the Meilisearch backbone is wired up (MEILISEARCH_HOST present). */
export function meiliConfigured(): boolean {
  return Boolean(process.env.MEILISEARCH_HOST);
}

/** Read Meili config from the environment (kept here so callers stay simple). */
export function meiliEnv() {
  return {
    host: process.env.MEILISEARCH_HOST,
    key: process.env.MEILISEARCH_KEY,
  };
}

export type SearchMeiliResult =
  | { ok: true; hits: SearchHit[] }
  | { ok: false; error: typeof MEILI_NOT_CONFIGURED | string };

/**
 * Search via Meilisearch. Until the SDK is wired this is a scaffold: it returns a
 * not-configured result (and makes NO network call) so globalSearch transparently
 * falls back to Postgres FTS. Never throws for the offline/unconfigured case.
 */
export async function searchMeili(
  _orgId: string,
  _query: string,
): Promise<SearchMeiliResult> {
  if (!meiliConfigured()) return { ok: false, error: MEILI_NOT_CONFIGURED };

  // TODO: wire Meilisearch — construct the client from meiliEnv(), run a
  // multi-search across the per-org contacts/companies/deals indexes (filtered by
  // orgId), and map results to SearchHit[]. For now, stay scaffolded so the live
  // Postgres path is used.
  return { ok: false, error: MEILI_NOT_CONFIGURED };
}
