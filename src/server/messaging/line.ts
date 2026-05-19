import { messagingApi } from "@line/bot-sdk";
import { env } from "@/env";
import type { ChannelDriver, SendInput, SendResult } from "./types";

let client: messagingApi.MessagingApiClient | null = null;

export function getLineClient(): messagingApi.MessagingApiClient | null {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  if (!client) {
    client = new messagingApi.MessagingApiClient({
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
    });
  }
  return client;
}

export const lineDriver: ChannelDriver = {
  channel: "LINE",
  isConfigured() {
    return Boolean(env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_CHANNEL_SECRET);
  },
  async send({ to, subject, body }: SendInput): Promise<SendResult> {
    const c = getLineClient();
    if (!c) return { ok: false, error: "LINE channel is not configured" };
    const text = subject ? `${subject}\n\n${body}` : body;
    try {
      const res = await c.pushMessage({
        to,
        messages: [{ type: "text", text }],
      });
      const id = res.sentMessages?.[0]?.id;
      return { ok: true, providerMessageId: id ? String(id) : undefined };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown LINE error" };
    }
  },
};
