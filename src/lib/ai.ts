import Anthropic from "@anthropic-ai/sdk";

/**
 * AI assistant infrastructure (M14), powered by Claude. Fully env-gated: with no
 * ANTHROPIC_API_KEY the app still builds and runs — {@link getAnthropic} returns
 * null and {@link complete} returns a graceful not-configured result instead of
 * throwing. When a key IS present the calls go out live.
 *
 * The default model comes from AI_MODEL, falling back to "claude-sonnet-4-6".
 * Prompt-building lives in small PURE helpers (buildDealContext, etc.) so they
 * are unit-testable without a key or a network.
 */

/** Shared "AI is not configured" sentinel returned everywhere a key is absent. */
export const AI_NOT_CONFIGURED = "AI is not configured" as const;

/** Default model when AI_MODEL is unset. Kept modest for cost. */
export const DEFAULT_AI_MODEL = "claude-sonnet-4-6";

let cached: Anthropic | null | undefined;

/** Lazily-constructed Anthropic client. Returns null when ANTHROPIC_API_KEY is unset. */
export function getAnthropic(): Anthropic | null {
  if (cached !== undefined) return cached;
  const key = process.env.ANTHROPIC_API_KEY;
  cached = key ? new Anthropic({ apiKey: key }) : null;
  return cached;
}

/** Reset the memoized client. Test-only seam; never used in app code. */
export function _resetAnthropicForTests(): void {
  cached = undefined;
}

/** Resolve the model: AI_MODEL override → safe default. */
export function resolveModel(): string {
  const m = process.env.AI_MODEL;
  return m && m.length > 0 ? m : DEFAULT_AI_MODEL;
}

export type CompleteInput = {
  system: string;
  prompt: string;
  /** Output cap. Modest by default to keep token usage in check. */
  maxTokens?: number;
};

export type CompleteResult =
  | { ok: true; text: string }
  | { ok: false; error: typeof AI_NOT_CONFIGURED | string };

/**
 * Single-shot completion helper. Returns the response text, or a graceful
 * `{ ok: false }` result — never throws for the offline case, and converts
 * provider/network errors into a friendly failure too.
 */
export async function complete({ system, prompt, maxTokens = 700 }: CompleteInput): Promise<CompleteResult> {
  const client = getAnthropic();
  if (!client) return { ok: false, error: AI_NOT_CONFIGURED };

  try {
    const res = await client.messages.create({
      model: resolveModel(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return { ok: true, text };
  } catch {
    // Provider/network/auth errors degrade gracefully rather than crashing the action.
    return { ok: false, error: "AI request failed" };
  }
}
