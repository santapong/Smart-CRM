import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/env";

export const runtime = "nodejs";

// Telegram POSTs JSON updates. When setWebhook was called with `secret_token`,
// Telegram echoes it back in this header — verify before doing anything.
const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export async function POST(req: Request) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: "Telegram not configured" }, { status: 503 });
  }
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers.get(SECRET_HEADER);
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const msg = update?.message ?? update?.edited_message;
  if (!msg?.chat?.id) {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(msg.chat.id);
  const text: string = msg.text ?? msg.caption ?? "";

  // telegramChatId is globally unique in the schema, so findUnique gives us
  // exactly the contact this chat belongs to. Cross-org leak is impossible.
  const contact = await db.contact.findUnique({ where: { telegramChatId: chatId } });

  if (contact) {
    // Only store the message subobject as the audit payload — never the full
    // update, which can carry unrelated PII from forwards / via_bot, and to
    // keep secret-shaped fields from a future change out of the DB.
    await db.messageLog.create({
      data: {
        orgId: contact.orgId,
        contactId: contact.id,
        channel: "TELEGRAM",
        direction: "INBOUND",
        status: "RECEIVED",
        body: text,
        fromAddress: chatId,
        providerMessageId: msg.message_id ? String(msg.message_id) : null,
        payload: msg,
        sentAt: msg.date ? new Date(msg.date * 1000) : new Date(),
      },
    });
  }
  // Unmapped chat ids are dropped silently — an "unknown sender" inbox is a
  // follow-up feature.

  return NextResponse.json({ ok: true });
}
