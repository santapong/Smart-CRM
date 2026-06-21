import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { putObject } from "@/lib/storage";

/**
 * File upload endpoint (M18). POST multipart/form-data with a `file` field and
 * an optional entity link (`dealId` | `contactId` | `companyId` | `documentId`).
 * Validates size/type, stores via the storage adapter (local fs by default,
 * Vercel Blob when configured), then creates an org-scoped Attachment row.
 *
 * Authenticated via the session (requireOrg) — NOT in the public allowlist. Uses
 * the nodejs runtime because the local backend writes to the filesystem.
 */

export const runtime = "nodejs";

/** Max upload size (10 MB) — keeps local/dev storage sane. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Allowed content-type prefixes/exacts. Conservative but covers common docs. */
const ALLOWED_TYPES = [
  "application/pdf",
  "image/",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument", // docx/xlsx/pptx
  "application/vnd.ms-excel",
  "application/json",
];

function typeAllowed(contentType: string): boolean {
  return ALLOWED_TYPES.some((t) => (t.endsWith("/") ? contentType.startsWith(t) : contentType === t));
}

export async function POST(req: Request): Promise<Response> {
  let orgId: string;
  let userId: string;
  try {
    const ctx = await requireOrg();
    orgId = ctx.orgId;
    userId = ctx.userId;
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });

  const contentType = file.type || "application/octet-stream";
  if (!typeAllowed(contentType)) {
    return NextResponse.json({ error: "Unsupported file type" }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }

  // Validate that any provided entity link belongs to the caller's org.
  const dealId = strOrNull(form.get("dealId"));
  const contactId = strOrNull(form.get("contactId"));
  const companyId = strOrNull(form.get("companyId"));
  const documentId = strOrNull(form.get("documentId"));
  const linkError = await assertLinksInOrg(orgId, { dealId, contactId, companyId, documentId });
  if (linkError) return NextResponse.json({ error: linkError }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const stored = await putObject(orgId, file.name || "file", buffer, contentType);

  const attachment = await db.attachment.create({
    data: {
      orgId,
      filename: file.name || "file",
      contentType,
      size: buffer.byteLength,
      storageKey: stored.storageKey,
      url: stored.url,
      dealId,
      contactId,
      companyId,
      documentId,
      uploadedById: userId,
    },
  });

  return NextResponse.json({
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    url: `/api/files/${encodeURI(attachment.storageKey)}`,
  });
}

function strOrNull(v: FormDataEntryValue | null): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Ensure each provided entity id exists within the org; returns an error message or null. */
async function assertLinksInOrg(
  orgId: string,
  links: { dealId: string | null; contactId: string | null; companyId: string | null; documentId: string | null },
): Promise<string | null> {
  if (links.dealId && !(await db.deal.findFirst({ where: { id: links.dealId, orgId }, select: { id: true } })))
    return "Deal not found";
  if (links.contactId && !(await db.contact.findFirst({ where: { id: links.contactId, orgId }, select: { id: true } })))
    return "Contact not found";
  if (links.companyId && !(await db.company.findFirst({ where: { id: links.companyId, orgId }, select: { id: true } })))
    return "Company not found";
  if (links.documentId && !(await db.document.findFirst({ where: { id: links.documentId, orgId }, select: { id: true } })))
    return "Document not found";
  return null;
}
