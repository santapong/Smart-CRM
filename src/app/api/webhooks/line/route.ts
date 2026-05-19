import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/env";

export const runtime = "nodejs";

function verifyLineSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!env.LINE_CHANNEL_SECRET) {
    return NextResponse.json({ error: "LINE not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const sig = req.headers.get("x-line-signature");
  if (!verifyLineSignature(rawBody, sig, env.LINE_CHANNEL_SECRET)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const events: any[] = Array.isArray(body?.events) ? body.events : [];
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const userId: string | undefined = ev.source?.userId;
    if (!userId) continue;

    const contact = await db.contact.findFirst({ where: { lineUserId: userId } });
    if (!contact) continue;

    await db.messageLog.create({
      data: {
        orgId: contact.orgId,
        contactId: contact.id,
        channel: "LINE",
        direction: "INBOUND",
        status: "RECEIVED",
        body: ev.message.text ?? "",
        fromAddress: userId,
        providerMessageId: ev.message.id ? String(ev.message.id) : null,
        payload: ev,
        sentAt: ev.timestamp ? new Date(ev.timestamp) : new Date(),
      },
    });
  }

  return NextResponse.json({ ok: true });
}
