import { authenticateApiRequest, requireScope, forbiddenScope, type ApiAuth } from "@/lib/api/auth";
import { apiOk, apiError, parsePagination, paginate } from "@/lib/api/respond";
import { getIdempotentResult, saveIdempotentResult, idempotencyKeyFrom } from "@/lib/api/idempotency";

/**
 * Shared plumbing for v1 collection routes (M12): authenticate + rate-limit,
 * enforce a scope, then run org-scoped, cursor-paginated reads or idempotent
 * creates. Each resource route supplies its model query + serializer; the
 * uniform auth/pagination/idempotency lives here so the contacts/deals/leads
 * (and future companies/activities) routes stay thin and consistent.
 */

/** Gate a request: returns `{ auth }` or a ready-to-return error `{ response }`. */
export async function gate(
  req: Request,
  scope: string,
): Promise<{ auth: ApiAuth; response?: undefined } | { auth?: undefined; response: Response }> {
  const res = await authenticateApiRequest(req);
  if (res.response) return { response: res.response };
  if (!requireScope(res.auth.scopes, scope)) return { response: forbiddenScope(scope) };
  return { auth: res.auth };
}

/**
 * Generic cursor-paginated list. `query` fetches `take` rows (it is given
 * `take`/`cursor`/`skip` already incremented to detect a further page) scoped
 * to the org; `serialize` maps each row to its public shape.
 */
export async function listCollection<Row extends { id: string }>(
  req: Request,
  scope: string,
  query: (args: { orgId: string; take: number; cursor?: { id: string }; skip?: number }) => Promise<Row[]>,
  serialize: (row: Row) => unknown,
): Promise<Response> {
  const g = await gate(req, scope);
  if (g.response) return g.response;

  const url = new URL(req.url);
  const { take, cursor, skip } = parsePagination(url);
  // Fetch one extra row to compute next_cursor without a count.
  const rows = await query({ orgId: g.auth.orgId, take: take + 1, cursor, skip });
  const page = paginate(rows, take);
  return apiOk(page.data.map(serialize), { next_cursor: page.next_cursor });
}

/**
 * Idempotent create. Honors the `Idempotency-Key` header: on replay returns the
 * stored result; otherwise runs `create`, stores its serialized result, and
 * returns 201. `create` returns either a created row or a validation error.
 */
export async function createResource<Row>(
  req: Request,
  scope: string,
  create: (auth: ApiAuth, body: unknown) => Promise<{ ok: true; row: Row } | { ok: false; message: string }>,
  serialize: (row: Row) => unknown,
): Promise<Response> {
  const g = await gate(req, scope);
  if (g.response) return g.response;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return apiError("invalid_request", "Request body must be valid JSON");
  }

  const idemKey = idempotencyKeyFrom(req);
  if (idemKey) {
    const prior = await getIdempotentResult(g.auth.orgId, idemKey);
    if (prior !== null) return apiOk(prior, undefined, { status: 200 });
  }

  const result = await create(g.auth, body);
  if (!result.ok) return apiError("invalid_request", result.message);

  const data = serialize(result.row);
  if (idemKey) await saveIdempotentResult(g.auth.orgId, idemKey, data as object);
  return apiOk(data, undefined, { status: 201 });
}
