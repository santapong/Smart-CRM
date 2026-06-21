import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// TODO (M1): defense-in-depth — evaluate a Prisma client extension / Postgres
// RLS to auto-assert orgId on tenant models. Deferred: query-rewriting the
// client risks regressions across all existing queries; today we scope by orgId
// explicitly in every server action.

/**
 * Optimistic concurrency control (M1) — additive helper.
 *
 * Business tables (Contact/Company/Deal/Activity) carry a `version Int`. On
 * every update we bump it with `version: { increment: 1 }`. When a caller passes
 * an `expectedVersion`, the update runs as `updateMany` guarded by
 * `version: expectedVersion`; a `count` of 0 means a concurrent write changed
 * the row, surfaced as {@link OCC_CONFLICT_MESSAGE}.
 */
export const OCC_CONFLICT_MESSAGE = "This record was changed by someone else — reload and retry";

export type OptimisticResult = { ok: true } | { ok: false; conflict: true };

/**
 * Run an optimistic update against a tenant model.
 *
 * - With `expectedVersion`: `updateMany({ where: { id, orgId, version }, data })`
 *   and bumps the version; returns a conflict when no row matched.
 * - Without `expectedVersion`: `update({ where: { id }, data })` (caller has
 *   already verified org ownership), still bumping the version.
 *
 * `data` must not set `version` — the bump is applied here.
 */
export async function optimisticUpdate<
  Delegate extends {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: { id: string; orgId: string; version: number };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  },
>(
  model: Delegate,
  params: {
    id: string;
    orgId: string;
    data: Record<string, unknown>;
    expectedVersion?: number;
  },
): Promise<OptimisticResult> {
  const data = { ...params.data, version: { increment: 1 } };

  if (typeof params.expectedVersion === "number") {
    const res = await model.updateMany({
      where: { id: params.id, orgId: params.orgId, version: params.expectedVersion },
      data,
    });
    if (res.count === 0) return { ok: false, conflict: true };
    return { ok: true };
  }

  await model.update({ where: { id: params.id }, data });
  return { ok: true };
}
