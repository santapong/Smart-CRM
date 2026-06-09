"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const tagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color like #3b82f6")
    .default("#64748b"),
});

export async function createTag(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.tag.findUnique({
    where: { orgId_name: { orgId, name: parsed.data.name } },
  });
  if (existing) return fail("A tag with that name already exists");
  const created = await db.tag.create({
    data: { orgId, name: parsed.data.name, color: parsed.data.color },
  });
  revalidatePath("/contacts");
  return ok({ id: created.id });
}

export async function deleteTag(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.tag.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/contacts");
  return ok({ id });
}

export async function setContactTags(
  contactId: string,
  tagIds: string[]
): Promise<ActionResult<{ contactId: string }>> {
  const parsed = z.array(z.string().min(1)).max(50).safeParse(tagIds);
  if (!parsed.success) return fail("Invalid input");
  const { orgId } = await requireOrg();

  const contact = await db.contact.findFirst({ where: { id: contactId, orgId } });
  if (!contact) return fail("Not found");

  const ids = Array.from(new Set(parsed.data));
  if (ids.length > 0) {
    const owned = await db.tag.count({ where: { id: { in: ids }, orgId } });
    if (owned !== ids.length) return fail("Not found");
  }

  await db.$transaction([
    db.contactTag.deleteMany({ where: { contactId } }),
    ...(ids.length > 0
      ? [db.contactTag.createMany({ data: ids.map((tagId) => ({ contactId, tagId })) })]
      : []),
  ]);

  revalidatePath("/contacts");
  revalidatePath(`/contacts/${contactId}`);
  return ok({ contactId });
}
