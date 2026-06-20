import Stripe from "stripe";

/**
 * Lazily-constructed Stripe client (M4). Returns null when STRIPE_SECRET_KEY is
 * unset so the app builds and runs fully offline — no module-level throw.
 */
let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  cached = key ? new Stripe(key) : null;
  return cached;
}
