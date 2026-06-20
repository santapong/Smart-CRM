import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { isPlanKey, type PlanKey } from "@/lib/plans";
import { db } from "@/lib/db";

/**
 * Stripe webhook (M4). Env-gated: with STRIPE_WEBHOOK_SECRET unset this returns
 * 501 (disabled) and never touches Stripe — so the app builds/runs offline.
 * When configured it verifies the signature and mirrors Subscription lifecycle
 * events into the local Subscription table.
 */

export const runtime = "nodejs";

/** Loosely map a Stripe price → internal plan key (nickname/metadata based). */
function planFromSubscription(sub: Stripe.Subscription): PlanKey {
  const price = sub.items.data[0]?.price;
  const candidates = [
    price?.metadata?.plan,
    price?.nickname,
    price?.lookup_key,
    sub.metadata?.plan,
  ];
  for (const c of candidates) {
    if (c && isPlanKey(c.toLowerCase())) return c.toLowerCase() as PlanKey;
  }
  return "free";
}

/** Read current_period_end defensively (it lives on items in newer API versions). */
function periodEnd(sub: Stripe.Subscription): Date | null {
  const item = sub.items.data[0] as { current_period_end?: number } | undefined;
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const ts = item?.current_period_end ?? top;
  return typeof ts === "number" ? new Date(ts * 1000) : null;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripe();
  if (!secret || !stripe) {
    return NextResponse.json({ error: "Stripe billing is not configured" }, { status: 501 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, secret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerMeta =
        typeof sub.customer === "object" && !sub.customer.deleted
          ? sub.customer.metadata
          : undefined;
      const orgId = sub.metadata?.orgId ?? customerMeta?.orgId;
      if (!orgId) break; // can't map to a tenant; ignore safely

      const deleted = event.type === "customer.subscription.deleted";
      const plan = deleted ? "free" : planFromSubscription(sub);
      const status = deleted ? "canceled" : sub.status;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

      await db.subscription.upsert({
        where: { orgId },
        create: {
          orgId,
          plan,
          status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: periodEnd(sub),
        },
        update: {
          plan,
          status,
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.id,
          currentPeriodEnd: periodEnd(sub),
        },
      });
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
