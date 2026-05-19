import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { MessageStatus } from "@prisma/client";

export const runtime = "nodejs";

// Resend webhook signing uses Svix headers. Verifying them properly requires
// the `svix` library; for now we only consume the event and map delivery state
// when we recognize our own provider message id. If RESEND_WEBHOOK_SECRET is
// set, callers should plug in svix verification here.
const EVENT_TO_STATUS: Record<string, MessageStatus | undefined> = {
  "email.sent": "SENT",
  "email.delivered": "DELIVERED",
  "email.bounced": "FAILED",
  "email.complained": "FAILED",
  "email.delivery_delayed": undefined,
};

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const type: string | undefined = body?.type;
  const providerMessageId: string | undefined = body?.data?.email_id ?? body?.data?.id;
  if (!type || !providerMessageId) return NextResponse.json({ ok: true });

  const status = EVENT_TO_STATUS[type];
  if (!status) return NextResponse.json({ ok: true });

  const log = await db.messageLog.findFirst({ where: { providerMessageId } });
  if (!log) return NextResponse.json({ ok: true });

  await db.messageLog.update({
    where: { id: log.id },
    data: {
      status,
      error: status === "FAILED" ? type : null,
    },
  });

  return NextResponse.json({ ok: true });
}
