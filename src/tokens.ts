/**
 * Token estimation.
 *
 * Thrift meters tokens everywhere, so it needs a cheap, dependency-free estimate
 * on the hot path. We use the well-known ~4-characters-per-token heuristic, which
 * tracks GPT/Claude BPE tokenizers closely enough for budgeting and savings math.
 *
 * This is intentionally pluggable: M2's proxy can swap in a real tokenizer
 * (tiktoken / @anthropic-ai) for exact billing numbers without touching callers.
 */

const CHARS_PER_TOKEN = 4;

/** Estimate the token count of a string. Always >= 0; empty string -> 0. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Round up: a partial token still costs a whole token to send.
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Sum the estimated tokens across many strings. */
export function estimateTokensAll(texts: readonly string[]): number {
  let total = 0;
  for (const t of texts) total += estimateTokens(t);
  return total;
}
