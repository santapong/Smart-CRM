"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { emit, EVENTS } from "@/lib/events";
import {
  ESIGN_PROVIDER,
  esignConfigured,
  requestSignature,
  ESIGN_NOT_CONFIGURED_REASON,
} from "@/lib/esign";

/**
 * eSignature request actions (M18 — env-gated scaffold). ADMIN-gated and
 * org-scoped. A SignatureRequest row is ALWAYS recorded (PENDING) so the request
 * is tracked; the live provider send only happens when eSign is configured (see
 * src/lib/esign.ts). When it is not, we still create the row and return a
 * friendly "configure eSign to send" message — the graceful unconfigured path.
 */

const createSchema = z.object({
  documentId: z.string().min(1),
  signers: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().trim().max(160).optional().or(z.literal("")),
      }),
    )
    .min(1, "Add at least one signer")
    .max(20),
});

export async function createSignatureRequest(
  input: unknown,
): Promise<ActionResult<{ id: string; configured: boolean; message: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  let userId: string;
  try {
    const ctx = await requireOrg();
    requireRole(ctx.role, "ADMIN");
    orgId = ctx.orgId;
    userId = ctx.userId;
  } catch {
    return fail("Forbidden");
  }

  const document = await db.document.findFirst({ where: { id: parsed.data.documentId, orgId } });
  if (!document) return fail("Document not found");

  const signers = parsed.data.signers.map((s) => ({
    email: s.email,
    ...(s.name ? { name: s.name } : {}),
  }));

  const configured = esignConfigured();

  // Always record the request so it's tracked; attempt the live send only when
  // configured. The send helper is graceful (never throws) when eSign is off.
  const created = await db.$transaction(async (tx) => {
    const row = await tx.signatureRequest.create({
      data: {
        orgId,
        documentId: document.id,
        provider: ESIGN_PROVIDER,
        status: "PENDING",
        signers: signers as Prisma.InputJsonValue,
        createdById: userId,
      },
    });
    await emit(tx, {
      orgId,
      name: EVENTS.SIGNATURE_REQUESTED,
      payload: { signatureRequestId: row.id, documentId: document.id, configured },
    });
    return row;
  });

  if (configured) {
    const sent = await requestSignature({
      title: document.title,
      content: document.content,
      signers,
    });
    if (sent.ok) {
      await db.signatureRequest.update({
        where: { id: created.id },
        data: { status: "SENT", externalId: sent.externalId },
      });
      await db.document.update({ where: { id: document.id }, data: { status: "SENT" } });
      revalidatePath("/documents");
      return ok({ id: created.id, configured: true, message: "Sent for signature" });
    }
    // Live send failed — keep the PENDING row and surface why.
    revalidatePath("/documents");
    return ok({ id: created.id, configured: true, message: sent.error });
  }

  revalidatePath("/documents");
  return ok({ id: created.id, configured: false, message: ESIGN_NOT_CONFIGURED_REASON });
}
