"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";

const channelEnum = z.enum(["EMAIL", "TELEGRAM", "LINE"]);

const contactSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(40).optional().or(z.literal("")),
  title: z.string().max(80).optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  notes: z.string().max(4000).optional().or(z.literal("")),
  telegramChatId: z.string().max(64).optional().or(z.literal("")),
  lineUserId: z.string().max(64).optional().or(z.literal("")),
  preferredChannel: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    channelEnum.optional(),
  ),
  emailOptIn: z.union([z.literal("on"), z.boolean()]).optional(),
  telegramOptIn: z.union([z.literal("on"), z.boolean()]).optional(),
  lineOptIn: z.union([z.literal("on"), z.boolean()]).optional(),
});

function clean(v: string | undefined) {
  return v && v.length > 0 ? v : null;
}

function checkbox(v: unknown) {
  return v === true || v === "on";
}

// HTML checkboxes only submit when checked. The form sends a hidden
// `_channelsForm=1` marker so we know "field absent" means "explicitly off",
// rather than "this caller didn't touch preferences at all".
function buildOptInPatch(raw: Record<string, unknown>, parsed: z.infer<typeof contactSchema>) {
  if (raw._channelsForm == null) return {};
  return {
    emailOptIn: checkbox(parsed.emailOptIn),
    telegramOptIn: checkbox(parsed.telegramOptIn),
    lineOptIn: checkbox(parsed.lineOptIn),
  };
}

export async function createContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;
  const raw = (input ?? {}) as Record<string, unknown>;
  const created = await db.contact.create({
    data: {
      orgId,
      firstName: d.firstName,
      lastName: d.lastName,
      email: clean(d.email),
      phone: clean(d.phone),
      title: clean(d.title),
      companyId: clean(d.companyId),
      notes: clean(d.notes),
      telegramChatId: clean(d.telegramChatId),
      lineUserId: clean(d.lineUserId),
      preferredChannel: d.preferredChannel ?? null,
      ...buildOptInPatch(raw, d),
    },
  });
  revalidatePath("/contacts");
  return ok({ id: created.id });
}

export async function updateContact(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const existing = await db.contact.findFirst({ where: { id, orgId } });
  if (!existing) return fail("Not found");
  const d = parsed.data;
  const raw = (input ?? {}) as Record<string, unknown>;
  await db.contact.update({
    where: { id },
    data: {
      firstName: d.firstName,
      lastName: d.lastName,
      email: clean(d.email),
      phone: clean(d.phone),
      title: clean(d.title),
      companyId: clean(d.companyId),
      notes: clean(d.notes),
      telegramChatId: clean(d.telegramChatId),
      lineUserId: clean(d.lineUserId),
      preferredChannel: d.preferredChannel ?? null,
      ...buildOptInPatch(raw, d),
    },
  });
  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  return ok({ id });
}

export async function deleteContact(id: string): Promise<ActionResult<{ id: string }>> {
  const { orgId } = await requireOrg();
  const res = await db.contact.deleteMany({ where: { id, orgId } });
  if (res.count === 0) return fail("Not found");
  revalidatePath("/contacts");
  return ok({ id });
}
