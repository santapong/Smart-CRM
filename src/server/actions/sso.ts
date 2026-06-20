"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { requireRole } from "@/lib/rbac";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { ssoConfigured } from "@/lib/sso";

/**
 * SSO (SAML) connection management (M16). ADMIN/OWNER only. This is a scaffold:
 * connections store the IdP SAML metadata so the wiring + UI exist, but the live
 * flow only runs once JACKSON_* env is set (see src/lib/sso.ts). All actions
 * work regardless of env — only the runtime SSO routes are gated.
 */

async function requireAdminOrg(): Promise<string> {
  const { orgId, role } = await requireOrg();
  requireRole(role, "ADMIN");
  return orgId;
}

const createSchema = z.object({
  label: z.string().trim().max(120).optional().or(z.literal("")),
  metadataXml: z.string().trim().max(100_000).optional().or(z.literal("")),
});

const updateSchema = z.object({
  label: z.string().trim().max(120).optional().or(z.literal("")),
  metadataXml: z.string().trim().max(100_000).optional().or(z.literal("")),
  status: z.enum(["active", "inactive"]).optional(),
});

const c = (v: string | undefined) => (v && v.length > 0 ? v : null);

export async function createSSOConnection(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const created = await db.sSOConnection.create({
    data: {
      orgId,
      provider: "saml",
      label: c(parsed.data.label),
      metadataXml: c(parsed.data.metadataXml),
      status: "inactive",
    },
  });
  revalidatePath("/settings");
  return ok({ id: created.id });
}

export async function updateSSOConnection(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.sSOConnection.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const { label, metadataXml, status } = parsed.data;
  await db.sSOConnection.update({
    where: { id },
    data: {
      ...(label !== undefined ? { label: c(label) } : {}),
      ...(metadataXml !== undefined ? { metadataXml: c(metadataXml) } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  revalidatePath("/settings");
  return ok({ id });
}

export async function deleteSSOConnection(id: string): Promise<ActionResult<{ id: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.sSOConnection.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id });
}

/**
 * Activate a connection. Activation requires both stored metadata and the
 * JACKSON_* backbone — without it we keep the connection inactive and tell the
 * admin what to configure (scaffold; no live flow).
 */
export async function activateSSOConnection(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const existing = await db.sSOConnection.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  if (!existing.metadataXml) return fail("Paste IdP SAML metadata before activating");
  if (!ssoConfigured()) return fail("Set JACKSON_URL to enable SSO before activating");
  await db.sSOConnection.update({ where: { id }, data: { status: "active" } });
  revalidatePath("/settings");
  return ok({ id, status: "active" });
}

export async function deactivateSSOConnection(id: string): Promise<ActionResult<{ id: string; status: string }>> {
  let orgId: string;
  try {
    orgId = await requireAdminOrg();
  } catch {
    return fail("Forbidden");
  }
  const res = await db.sSOConnection.updateMany({ where: { id, orgId }, data: { status: "inactive" } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/settings");
  return ok({ id, status: "inactive" });
}
