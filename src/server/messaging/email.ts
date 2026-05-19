import { Resend } from "resend";
import { env } from "@/env";
import type { ChannelDriver, SendInput, SendResult } from "./types";

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

export const emailDriver: ChannelDriver = {
  channel: "EMAIL",
  isConfigured() {
    return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
  },
  async send({ to, subject, body }: SendInput): Promise<SendResult> {
    const c = getClient();
    if (!c || !env.EMAIL_FROM) {
      return { ok: false, error: "Email channel is not configured" };
    }
    try {
      const res = await c.emails.send({
        from: env.EMAIL_FROM,
        to,
        subject: subject ?? "(no subject)",
        text: body,
      });
      if (res.error) return { ok: false, error: res.error.message };
      return { ok: true, providerMessageId: res.data?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown email error" };
    }
  },
};
