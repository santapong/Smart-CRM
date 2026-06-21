import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { readObject } from "@/lib/storage";

/**
 * File download endpoint (M18). GET /api/files/<storageKey> resolves the
 * Attachment by its unique storageKey and ENFORCES TENANT ISOLATION: the row
 * must belong to the caller's own org, otherwise we 404 (never reveal another
 * org's files). Local files are streamed from disk; Blob-backed files redirect to
 * their public URL.
 *
 * Authenticated via the session (requireOrg) — NOT in the public allowlist. Uses
 * the nodejs runtime because the local backend reads from the filesystem.
 */

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  let orgId: string;
  try {
    ({ orgId } = await requireOrg());
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { key } = await params;
  const storageKey = decodeURIComponent((key ?? []).join("/"));
  if (!storageKey) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Tenant isolation: scope the lookup to the caller's org. A cross-org key
  // simply doesn't match, yielding a 404 (no information leak).
  const attachment = await db.attachment.findFirst({ where: { storageKey, orgId } });
  if (!attachment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Blob-backed files live behind a CDN URL — redirect there.
  if (attachment.url) return NextResponse.redirect(attachment.url);

  // Local backend: stream the bytes from disk.
  const bytes = await readObject(attachment.storageKey);
  if (!bytes) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": attachment.contentType,
      "content-length": String(bytes.byteLength),
      "content-disposition": `inline; filename="${encodeURIComponent(attachment.filename)}"`,
    },
  });
}
