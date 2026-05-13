import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";

export type Role = "OWNER" | "ADMIN" | "MEMBER";

export class AuthError extends Error {}
export class TenantError extends Error {}

export async function getSessionOrRedirect() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session;
}

export async function requireOrg(): Promise<{ userId: string; orgId: string; role: Role }> {
  const session = await auth();
  if (!session?.user?.id) throw new AuthError("Not signed in");
  const orgId = session.user.activeOrgId;
  if (!orgId) throw new TenantError("No active organization");
  const role = (session.user.role ?? "MEMBER") as Role;
  return { userId: session.user.id, orgId, role };
}

export async function getCurrentOrg() {
  try {
    const { orgId } = await requireOrg();
    return db.organization.findUnique({ where: { id: orgId } });
  } catch {
    return null;
  }
}

export async function listMyOrgs(userId: string) {
  return db.membership.findMany({
    where: { userId },
    include: { org: true },
    orderBy: { createdAt: "asc" },
  });
}
