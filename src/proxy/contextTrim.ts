/**
 * Context trimming — the cost-wedge core of the M2b proxy/gateway (THIRFT-M2b).
 *
 * The proxy sees the FULL request an agent sends to the LLM API (system prompt +
 * whole message history). The biggest token waste is this always-injected
 * context. `trimContext` replaces "send everything" with "send the relevant
 * slice under a hard token budget", then reports the savings as a receipt —
 * exactly like `ScopedRetriever` does for fleet memory, but for a live request.
 *
 * Strategy (mirrors ScopedRetriever's greedy pack):
 *   1. Normalize the request into context entries (system block + each message),
 *      estimating the token cost of each.
 *   2. Rank by priority — the LAST message is the current task (essential, kept
 *      whole or, if it alone busts the budget, COMPRESSED by truncation); the
 *      system block and older history are trimmable, newest-first.
 *   3. Pack greedily under the HARD token budget; entries that don't fit are
 *      STRIPPED (dropped). Essential entries are force-kept so we never forward
 *      an invalid empty request.
 *
 * Baseline integrity (lessons-learned 2026-06-21): `baselineTokens` is the cost
 * of the UNMODIFIED request — what would have been sent WITHOUT Thrift. It is
 * computed over the full entry set BEFORE trimming and is NOT a function of the
 * budget, so `savedTokens = baselineTokens - injectedTokens` is always honest.
 *
 * Supports both the Anthropic Messages shape (top-level `system` + `messages`)
 * and the OpenAI Chat Completions shape (a `system` role inside `messages`).
 * Non-context fields (model, temperature, tools, …) are passed through untouched.
 */

import { estimateTokens } from "../tokens.js";

/** A single chat message in either Anthropic or OpenAI shape. */
export interface ChatMessage {
  role: string;
  /** String, a content-block array, or anything else the API accepts. */
  content: unknown;
  [k: string]: unknown;
}

/** A chat-completion request body, kept open so passthrough fields survive. */
export interface ChatRequest {
  /** Anthropic puts the system prompt at the top level. */
  system?: unknown;
  messages?: ChatMessage[];
  [k: string]: unknown;
}

/** Where a context entry came from, so we can rebuild the request faithfully. */
type EntrySource = "system" | "message";

interface ContextEntry {
  source: EntrySource;
  /** Index into `messages` (for source === "message"). */
  index: number;
  tokens: number;
  /** Higher wins the budget first. */
  priority: number;
  /** Essential entries are force-kept (truncated if needed), never stripped. */
  essential: boolean;
}

export interface TrimOptions {
  /** Hard ceiling on the tokens forwarded upstream. */
  tokenBudget: number;
}

export interface TrimResult {
  /** The trimmed request, ready to forward. A shallow copy — the input is untouched. */
  request: ChatRequest;
  /** Tokens forwarded after trimming. */
  injectedTokens: number;
  /** Tokens the unmodified request would have sent (the no-Thrift baseline). */
  baselineTokens: number;
  /** baselineTokens - injectedTokens. The provable savings for this request. */
  savedTokens: number;
  /** Count of context entries kept. */
  kept: number;
  /** Count of context entries stripped (dropped) to fit the budget. */
  dropped: number;
  /** True if an essential entry was compressed (truncated) to fit the budget. */
  compressed: boolean;
}

const TRUNCATION_MARKER = " …[trimmed by thrift]";

/**
 * Trim a chat request's context under a hard token budget, returning the
 * forwardable request plus a savings receipt. Pure: no I/O, no wall-clock reads.
 */
export function trimContext(request: ChatRequest, opts: TrimOptions): TrimResult {
  const budget = Math.max(0, opts.tokenBudget);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const hasSystem = request.system !== undefined && request.system !== null;

  // 1. Normalize to entries with token costs + priority.
  const entries: ContextEntry[] = [];
  if (hasSystem) {
    entries.push({
      source: "system",
      index: -1,
      tokens: estimateTokens(contentToText(request.system)),
      // System is high priority (the agent's instructions) but trimmable — it is
      // the big always-injected blob the cost wedge targets. Below the live turn.
      priority: 1_000,
      essential: false,
    });
  }
  const lastIndex = messages.length - 1;
  messages.forEach((m, i) => {
    entries.push({
      source: "message",
      index: i,
      tokens: estimateTokens(contentToText(m.content)),
      // Recency = priority; the final message is the current task → essential.
      priority: i === lastIndex ? 2_000_000 : i,
      essential: i === lastIndex,
    });
  });

  // 2. Baseline = the UNMODIFIED request's context cost (no-Thrift counterfactual).
  //    Computed over every entry BEFORE trimming — never narrowed by the budget.
  const baselineTokens = sum(entries.map((e) => e.tokens));

  // 3. Greedy pack by priority (essential first), honouring the hard budget.
  const ranked = [...entries].sort((a, b) => b.priority - a.priority);
  const keep = new Set<ContextEntry>();
  const truncate = new Map<ContextEntry, number>(); // entry -> kept tokens after compress
  let injectedTokens = 0;
  let compressed = false;

  for (const e of ranked) {
    const remaining = budget - injectedTokens;
    if (e.tokens <= remaining) {
      keep.add(e);
      injectedTokens += e.tokens;
      continue;
    }
    if (e.essential) {
      // Never drop the live turn: compress it to fit whatever budget is left.
      const keptTokens = Math.max(0, remaining);
      keep.add(e);
      truncate.set(e, keptTokens);
      injectedTokens += keptTokens;
      compressed = compressed || keptTokens < e.tokens;
    }
    // Non-essential over-budget entries are stripped (not added).
  }

  // 4. Rebuild the request in original order, dropping stripped entries.
  const trimmed: ChatRequest = { ...request };
  const systemEntry = entries.find((e) => e.source === "system");
  if (systemEntry && !keep.has(systemEntry)) {
    delete trimmed.system;
  } else if (systemEntry && truncate.has(systemEntry)) {
    trimmed.system = truncateContent(request.system, truncate.get(systemEntry)!);
  }

  const keptMessages: ChatMessage[] = [];
  messages.forEach((m, i) => {
    const entry = entries.find((e) => e.source === "message" && e.index === i)!;
    if (!keep.has(entry)) return; // stripped
    if (truncate.has(entry)) {
      keptMessages.push({ ...m, content: truncateContent(m.content, truncate.get(entry)!) });
    } else {
      keptMessages.push(m);
    }
  });
  if (request.messages !== undefined) trimmed.messages = keptMessages;

  // 5. HONEST RECEIPT: measure injectedTokens from the request we actually
  //    forward, not from the packing accumulator. truncateContent only shrinks
  //    string content — a content-block array is forwarded whole — so the budget-
  //    time `injectedTokens` could understate the real cost. Recomputing over
  //    `trimmed` makes `savedTokens` impossible to over-report by construction.
  const forwardedTokens = contextTokens(trimmed);
  // `compressed` should mean content actually got smaller, not merely targeted —
  // a non-truncatable essential block forwarded whole is not a real compression.
  const reallyCompressed = compressed && forwardedTokens < injectedTokensIfUntruncated(entries, keep);

  return {
    request: trimmed,
    injectedTokens: forwardedTokens,
    baselineTokens,
    savedTokens: baselineTokens - forwardedTokens,
    kept: keep.size,
    dropped: entries.length - keep.size,
    compressed: reallyCompressed,
  };
}

/** Token cost of a request's context (system block + each message), as forwarded. */
function contextTokens(req: ChatRequest): number {
  let t = 0;
  if (req.system !== undefined && req.system !== null) t += estimateTokens(contentToText(req.system));
  if (Array.isArray(req.messages)) {
    for (const m of req.messages) t += estimateTokens(contentToText(m.content));
  }
  return t;
}

/** What the kept set would cost with no truncation — to tell real compression apart. */
function injectedTokensIfUntruncated(entries: ContextEntry[], keep: Set<ContextEntry>): number {
  let t = 0;
  for (const e of entries) if (keep.has(e)) t += e.tokens;
  return t;
}

/** Best-effort text extraction for token estimation across content shapes. */
export function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Anthropic/OpenAI content-block arrays: concat any `.text` fields.
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const t = (block as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return JSON.stringify(block);
      })
      .join(" ");
  }
  return JSON.stringify(content);
}

/**
 * Compress content to roughly `keptTokens` tokens. Only string content is
 * truncated (structure-preserving); block arrays are kept whole to avoid
 * corrupting the request shape. Adds a marker so the model sees it was trimmed.
 */
function truncateContent(content: unknown, keptTokens: number): unknown {
  if (typeof content !== "string") return content;
  if (keptTokens <= 0) return TRUNCATION_MARKER.trim();
  const charBudget = Math.max(0, keptTokens * 4 - TRUNCATION_MARKER.length);
  if (content.length <= charBudget) return content;
  return content.slice(0, charBudget) + TRUNCATION_MARKER;
}

function sum(ns: number[]): number {
  let t = 0;
  for (const n of ns) t += n;
  return t;
}
