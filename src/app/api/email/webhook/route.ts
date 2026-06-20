import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Resend (Svix) email webhook (M7). Env-gated: with RESEND_WEBHOOK_SECRET unset
 * this is a 200 no-op so the app builds/runs offline. When configured it
 * verifies the Svix signature, then:
 *  - opened/clicked  → update the EmailMessage counters + insert an EmailEvent
 *  - bounced/complained → insert a Suppression for the recipient
 * EmailEvents are idempotent via the unique providerEventId.
 */

export const runtime = "nodejs";

/**
 * Verify a Svix webhook signature. Secret is `whsec_<base64>`; the signed
 * content is `${id}.${timestamp}.${body}` and `svix-signature` is a
 * space-separated list of `v1,<base64sig>` entries.
 */
function verifySvix(opts: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
}): boolean {
  const { secret, id, timestamp, signature, body } = opts;
  if (!id || !timestamp || !signature) return false;
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(key, "base64");
  } catch {
    return false;
  }
  const signed = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", secretBytes).update(signed).digest("base64");
  const expectedBuf = Buffer.from(expected);
  // Header may contain multiple space-delimited "version,signature" pairs.
  for (const part of signature.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

type ResendEvent = {
  type?: string;
  data?: {
    email_id?: string;
    to?: string | string[];
    click?: { link?: string };
    [k: string]: unknown;
  };
  created_at?: string;
};

function firstTo(to: string | string[] | undefined): string | null {
  if (!to) return null;
  return Array.isArray(to) ? to[0] ?? null : to;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  // Env-gated no-op: nothing configured → accept and ignore.
  if (!secret) return NextResponse.json({ received: true, skipped: true });

  const body = await req.text();
  const ok = verifySvix({
    secret,
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    body,
  });
  if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 400 });

  let event: ResendEvent;
  try {
    event = JSON.parse(body) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const type = event.type ?? "";
  const providerMessageId = event.data?.email_id ?? null;
  // Stable per-delivery-event id so retries are idempotent.
  const providerEventId =
    (event.data?.email_id ? `${event.data.email_id}:${type}:${event.created_at ?? ""}` : null) || null;

  // Locate the originating EmailMessage by provider id (best-effort).
  const message = providerMessageId
    ? await db.emailMessage.findFirst({ where: { providerMessageId } })
    : null;

  switch (type) {
    case "email.opened": {
      if (message) {
        await db.emailMessage.update({
          where: { id: message.id },
          data: {
            openCount: { increment: 1 },
            firstOpenedAt: message.firstOpenedAt ?? new Date(),
          },
        });
        await insertEvent(message.id, "opened", providerEventId);
      }
      break;
    }
    case "email.clicked": {
      if (message) {
        await db.emailMessage.update({
          where: { id: message.id },
          data: { clickCount: { increment: 1 }, lastClickedAt: new Date() },
        });
        await insertEvent(message.id, "clicked", providerEventId);
      }
      break;
    }
    case "email.bounced":
    case "email.complained": {
      const reason = type === "email.bounced" ? "bounced" : "complained";
      const to = firstTo(event.data?.to) ?? message?.toAddr ?? null;
      const orgId = message?.orgId ?? null;
      if (orgId && to) {
        await db.suppression.upsert({
          where: { orgId_email: { orgId, email: to.toLowerCase() } },
          create: { orgId, email: to.toLowerCase(), reason },
          update: { reason },
        });
      }
      if (message) await insertEvent(message.id, reason, providerEventId);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}

/** Insert an EmailEvent, ignoring duplicates (idempotent via providerEventId). */
async function insertEvent(emailMessageId: string, type: string, providerEventId: string | null): Promise<void> {
  if (providerEventId) {
    const existing = await db.emailEvent.findUnique({ where: { providerEventId } });
    if (existing) return;
  }
  try {
    await db.emailEvent.create({ data: { emailMessageId, type, providerEventId } });
  } catch {
    // Unique-constraint race on providerEventId → already recorded; ignore.
  }
}
