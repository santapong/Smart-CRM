"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOrg } from "@/lib/tenant";
import { ok, fail, type ActionResult } from "@/lib/action-result";
import { dispatchMessage } from "@/server/messaging";

const sendSchema = z
  .object({
    contactId: z.string().min(1),
    channel: z.enum(["EMAIL", "TELEGRAM", "LINE"]),
    subject: z.string().max(200).optional().or(z.literal("")),
    body: z.string().max(8000).optional().or(z.literal("")),
    templateKey: z.string().max(80).optional().or(z.literal("")),
  })
  .refine(
    (d) => (d.templateKey && d.templateKey.length > 0) || (d.body && d.body.length > 0),
    { message: "Provide a message body or a template key", path: ["body"] },
  );

function clean(v: string | undefined) {
  return v && v.length > 0 ? v : undefined;
}

export async function sendMessageToContact(input: unknown): Promise<ActionResult<{ messageLogId: string }>> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input", parsed.error.flatten().fieldErrors);
  const { orgId } = await requireOrg();
  const d = parsed.data;

  const result = await dispatchMessage(orgId, {
    contactId: d.contactId,
    channel: d.channel,
    subject: clean(d.subject),
    body: d.body ?? "",
    templateKey: clean(d.templateKey),
  });

  revalidatePath(`/contacts/${d.contactId}`);

  if (!result.ok) return fail(result.error);
  return ok({ messageLogId: result.messageLogId });
}
