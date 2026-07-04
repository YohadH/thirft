/**
 * `thrift-memory session-context` — the auto-memory injection for hooks.
 *
 * A Claude Code SessionStart hook's stdout is added to the session's context.
 * This builds that stdout: a budgeted recall of org + agent memory rendered as
 * a compact block, so installed users get memory automatically at every
 * "amnesia moment" (startup, resume, /clear, post-compaction) without the
 * agent having to call a tool.
 *
 * Contract: with no memories (or no store) it returns NO lines — a hook must
 * stay silent rather than inject noise, and must never fail the session.
 */

import type { MemoryStore } from "./store/index.js";
import type { Retriever } from "./retrieval/index.js";
import type { RecallResult } from "./types.js";

export interface SessionContextOptions {
  /** Attributed agent id on the meter (shows in the dashboard). Default "session-start". */
  agentId: string;
  /** Hard token budget for the injected slice. */
  tokenBudget: number;
}

export interface SessionContextOutput {
  /** Lines to print to stdout — empty means "inject nothing". */
  lines: string[];
  /** The recall receipt (undefined when the store had nothing to recall). */
  result?: RecallResult;
}

export function buildSessionContext(
  store: MemoryStore,
  retriever: Retriever,
  opts: SessionContextOptions,
): SessionContextOutput {
  // No task text on purpose: at session start there is no task yet, so the
  // retriever packs by pin/recency under the budget (its relevance floor is
  // off without query terms — that is the designed behavior, not a bypass).
  const result = retriever.recall(store, {
    agentId: opts.agentId,
    tokenBudget: opts.tokenBudget,
  });

  if (result.memories.length === 0) return { lines: [] };

  const lines: string[] = [];
  lines.push(
    `## Thrift Memory (auto-recalled ${result.injectedTokens}/${result.baselineTokens} tokens — saved ${result.savedTokens})`,
  );
  for (const m of result.memories) {
    lines.push(`- ${m.text}`);
  }
  return { lines, result };
}
