import { NextResponse } from "next/server";

/**
 * Public REST API response envelopes (M12).
 *
 * Success: `{ data, ... }` (plus `next_cursor` on paginated lists). Error:
 * `{ error: { code, message } }`. Keeping a single shape here means every v1
 * route reports consistently and clients can branch on `error`.
 */

/** A stable, machine-readable error code for the public API. */
export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "conflict"
  | "internal";

/** Wrap a payload in the success envelope. `extra` adds top-level keys (e.g. pagination). */
export function apiOk(
  data: unknown,
  extra?: Record<string, unknown>,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  return NextResponse.json({ data, ...(extra ?? {}) }, { status: init?.status ?? 200, headers: init?.headers });
}

/** Wrap an error in the error envelope with a stable code + human message. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  init?: { status?: number; headers?: HeadersInit },
): Response {
  const status = init?.status ?? statusForCode(code);
  return NextResponse.json({ error: { code, message } }, { status, headers: init?.headers });
}

function statusForCode(code: ApiErrorCode): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "invalid_request":
      return 400;
    case "rate_limited":
      return 429;
    case "conflict":
      return 409;
    default:
      return 500;
  }
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Parse `?limit=&cursor=` for keyset (cursor) pagination over `id`. Returns a
 * Prisma-ready fragment plus the requested limit. `cursor` is the last id seen.
 */
export function parsePagination(url: URL): {
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const take = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const cursor = url.searchParams.get("cursor") || undefined;
  if (cursor) return { take, cursor: { id: cursor }, skip: 1 };
  return { take };
}

/**
 * Build a paginated list envelope. Fetch `take + 1` rows so we can detect a
 * further page without a count; returns the trimmed rows + the `next_cursor`
 * (the id of the last returned row) or null when exhausted.
 */
export function paginate<T extends { id: string }>(
  rows: T[],
  take: number,
): { data: T[]; next_cursor: string | null } {
  const hasMore = rows.length > take;
  const data = hasMore ? rows.slice(0, take) : rows;
  const next_cursor = hasMore ? data[data.length - 1]!.id : null;
  return { data, next_cursor };
}
