import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { ingestFormSubmission, type FormField } from "@/lib/lead-ingest";

/**
 * Public web-form ingest (M8). NO auth — allowed through middleware via the
 * `/api/forms` public matcher in src/lib/auth.config.ts.
 *
 *  - rate-limited per client IP (no-op without Upstash configured)
 *  - silently drops bot submissions where the `_hp` honeypot is filled
 *  - reads UTM params from the body
 *  - dedupes by email within the org and creates a Lead + FormSubmission
 *  - returns CORS headers and handles the OPTIONS preflight
 */

export const runtime = "nodejs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;

function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function OPTIONS(): Response {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const ip = clientIp(req);
  const limited = await rateLimit("form:" + ip);
  if (!limited.success) return json({ ok: false, error: "Too many requests" }, 429);

  // Accept JSON or urlencoded/multipart form posts.
  let data: Record<string, unknown> = {};
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      data = (await req.json()) as Record<string, unknown>;
    } else {
      const fd = await req.formData();
      for (const [k, v] of fd.entries()) data[k] = typeof v === "string" ? v : v.name;
    }
  } catch {
    return json({ ok: false, error: "Invalid body" }, 400);
  }
  if (!data || typeof data !== "object") return json({ ok: false, error: "Invalid body" }, 400);

  // Honeypot: a filled `_hp` field means a bot. Pretend success, do nothing.
  const hp = data["_hp"];
  if (typeof hp === "string" && hp.trim().length > 0) return json({ ok: true });

  const form = await db.form.findUnique({ where: { id } });
  if (!form || !form.active) return json({ ok: false, error: "Form not found" }, 404);

  // Pull UTM params out of the body into a structured object.
  const utm: Record<string, unknown> = {};
  for (const k of UTM_KEYS) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) utm[k] = v;
  }

  await ingestFormSubmission({
    form: {
      id: form.id,
      orgId: form.orgId,
      name: form.name,
      fields: (form.fields as unknown as FormField[]) ?? [],
      active: form.active,
    },
    data,
    utm: Object.keys(utm).length > 0 ? utm : null,
  });

  return json({ ok: true });
}
