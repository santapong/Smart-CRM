import { Telegraf } from "telegraf";
import { env } from "@/env";
import type { ChannelDriver, SendInput, SendResult } from "./types";

let bot: Telegraf | null = null;

export function getTelegramBot(): Telegraf | null {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  if (!bot) bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  return bot;
}

export const telegramDriver: ChannelDriver = {
  channel: "TELEGRAM",
  isConfigured() {
    return Boolean(env.TELEGRAM_BOT_TOKEN);
  },
  async send({ to, subject, body }: SendInput): Promise<SendResult> {
    const b = getTelegramBot();
    if (!b) return { ok: false, error: "Telegram channel is not configured" };

    const chatId = Number(to);
    if (!Number.isFinite(chatId)) {
      return { ok: false, error: "Telegram recipient must be a numeric chat id" };
    }
    // No parse_mode here: user-typed bodies often contain `_` `*` `[` which
    // Markdown rejects with a 400. The cost is no bold subject, which is fine
    // for v1 — switch to MarkdownV2 with escaping when we add rich templates.
    const text = subject ? `${subject}\n\n${body}` : body;
    try {
      const msg = await b.telegram.sendMessage(chatId, text);
      return { ok: true, providerMessageId: String(msg.message_id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Unknown Telegram error" };
    }
  },
};
