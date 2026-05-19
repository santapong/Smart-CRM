import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/env";

export const runtime = "nodejs";

function verifyLineSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false;
  // Both the expected and provided signatures are base64-encoded SHA-256
  // HMACs. Decode them to bytes before timing-safe comparison, otherwise we'd
  // be comparing utf-8 string bytes — which happens to work for valid
  // signatures but masks tampering attempts behind an exception path.
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
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

    // lineUserId is globally unique in the schema — see Contact's @@unique.
    const contact = await db.contact.findUnique({ where: { lineUserId: userId } });
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
