"use server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { slugify } from "@/lib/utils";

const signUpSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().toLowerCase(),
  password: z.string().min(6).max(100),
  orgName: z.string().min(2).max(80),
});

const DEFAULT_STAGES = [
  { name: "Lead", order: 0, color: "#64748b" },
  { name: "Qualified", order: 1, color: "#0ea5e9" },
  { name: "Proposal", order: 2, color: "#8b5cf6" },
  { name: "Negotiation", order: 3, color: "#f59e0b" },
  { name: "Closing", order: 4, color: "#10b981" },
];

export async function signUpAction(input: unknown): Promise<ActionResult<{ userId: string; orgId: string }>> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);

  const { name, email, password, orgName } = parsed.data;
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return fail("Email already in use");

  const passwordHash = await bcrypt.hash(password, 10);

  const slugBase = slugify(orgName) || "team";
  let slug = slugBase;
  let i = 1;
  while (await db.organization.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${slugBase}-${i}`;
  }

  const result = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, name, passwordHash, emailVerified: new Date() },
    });
    const org = await tx.organization.create({
      data: {
        name: orgName,
        slug,
        memberships: { create: { userId: user.id, role: "OWNER" } },
        stages: { create: DEFAULT_STAGES },
      },
    });
    return { userId: user.id, orgId: org.id };
  });

  return ok(result);
}
