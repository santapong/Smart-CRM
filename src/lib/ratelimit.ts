import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Rate limiting (M1) — env-gated.
 *
 * When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are both set we
 * build a sliding-window limiter backed by Upstash Redis. Otherwise we fall
 * back to a no-op limiter that always allows, so the app builds, tests and runs
 * with no keys (CI/local). Tests therefore exercise the allow path by default.
 */

type Limiter = { limit: (identifier: string) => Promise<{ success: boolean }> };

const ALLOW_ALL: Limiter = {
  async limit() {
    return { success: true };
  },
};

let cached: Limiter | null = null;

function getLimiter(): Limiter {
  if (cached) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    cached = ALLOW_ALL;
    return cached;
  }

  const ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    // 10 requests per 60s sliding window, keyed per identifier.
    limiter: Ratelimit.slidingWindow(10, "60 s"),
    prefix: "smartcrm:rl",
  });

  cached = {
    limit: (identifier: string) => ratelimit.limit(identifier).then((r) => ({ success: r.success })),
  };
  return cached;
}

/**
 * Check the rate limit for `key`. Returns `{ success: true }` when allowed.
 * No-op (always allows) when Upstash env vars are not configured.
 */
export async function rateLimit(key: string): Promise<{ success: boolean }> {
  return getLimiter().limit(key);
}
