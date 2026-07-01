/**
 * Core domain types for Thrift's cost-first memory layer.
 *
 * Scope is the spine of the system: company-wide knowledge is stored once at
 * `org` scope and shared across the whole fleet, so 20 agents don't each re-load
 * the same context every run. Retrieval narrows from org -> agent -> session.
 */

/** Where a memory lives in the fleet hierarchy. */
export type Scope = "org" | "agent" | "session";

/** A single stored memory. Kept deliberately small — the write path is cheap. */
export interface MemoryRecord {
  /** Stable unique id. */
  id: string;
  /** Scope this memory belongs to. */
  scope: Scope;
  /** Agent this memory is scoped to (required when scope === "agent"). */
  agentId?: string;
  /** Session this memory is scoped to (required when scope === "session"). */
  sessionId?: string;
  /** The memory content itself. */
  text: string;
  /** Free-form tags for coarse filtering (e.g. project id, topic). */
  tags?: string[];
  /**
   * Pinned memories are ranked first (they get a large relevance boost), so they
   * get first claim on the token budget. This is NOT a budget bypass: the hard
   * `tokenBudget` still applies, so a pinned memory larger than the remaining
   * budget is skipped like any other. Pin to prioritize, not to guarantee.
   */
  pinned?: boolean;
  /** Disabled memories are never injected (owner kill-switch, per-memory). */
  disabled?: boolean;
  /** Estimated token cost of `text`, cached on write to keep retrieval cheap. */
  tokens: number;
  /** Epoch millis. Passed in by the caller — Thrift never reads the wall clock itself. */
  createdAt: number;
  /** Epoch millis of last update. */
  updatedAt: number;
}

/** What the caller provides to create a memory (server fills id/tokens/timestamps). */
export interface MemoryInput {
  scope: Scope;
  agentId?: string;
  sessionId?: string;
  text: string;
  tags?: string[];
  pinned?: boolean;
}

/** A retrieval request: who is asking, for what, and how much budget they have. */
export interface RecallQuery {
  /** The agent requesting context. */
  agentId: string;
  /** Optional session to include session-scoped memories. */
  sessionId?: string;
  /** Free-text describing the current task — used for relevance matching. */
  task?: string;
  /** Restrict to memories carrying any of these tags. */
  tags?: string[];
  /** Hard ceiling on injected tokens for this recall. */
  tokenBudget: number;
  /**
   * Quality-pairing fields (THRIFT-QUALITY-PAIRING). Optional pass-through
   * metadata that the meter records alongside the savings receipt so an A/B
   * runner can pair runs by task and compare outcome quality across modes.
   *
   * 'full' = full context loaded (baseline run), 'thin' = thrift recall used.
   */
  mode?: "full" | "thin";
  /** Which board task this run was serving (for A/B pairing). */
  taskId?: string;
  /** Agent-reported outcome: 'pass' | 'needs-fix' | 'error' | string. */
  outcome?: string;
}

/**
 * How much *relevant* memory the budget forced Thrift to leave behind. Cutting
 * tokens is only safe if the agent can tell "got everything relevant" apart from
 * "got a fraction of it" — otherwise a cost saving silently becomes a quality
 * loss. These signals make that visible so an agent (not the end user) can decide
 * to do one more focused recall. Deterministic and honest: every field is derived
 * from what the retriever already computed, never a fabricated suggestion.
 */
export type BudgetPressure = "none" | "low" | "high";

/** The result of a recall: the chosen slice plus the metering + pressure receipt. */
export interface RecallResult {
  /** Memories selected for injection, ordered by relevance then recency. */
  memories: MemoryRecord[];
  /** Tokens actually injected (sum of selected memories' `tokens`). */
  injectedTokens: number;
  /** Tokens the naive "load everything in scope" baseline would have injected. */
  baselineTokens: number;
  /** baselineTokens - injectedTokens. The provable savings for this recall. */
  savedTokens: number;
  /**
   * Total tokens of all memories that passed the relevance filter — i.e. the
   * context Thrift judged worth injecting before the budget was applied. When
   * this exceeds `injectedTokens`, the budget (not relevance) was the constraint.
   */
  relevantTokens: number;
  /** Count of *relevant* memories dropped solely because they didn't fit the budget. */
  skippedForBudget: number;
  /** Token cost of those budget-dropped relevant memories (`relevantTokens - injectedTokens`). */
  skippedTokensForBudget: number;
  /** True when at least one relevant memory was dropped for budget — a signal to consider recalling more. */
  hasMoreRelevantMemory: boolean;
  /**
   * How tight the budget was against the relevant set:
   *   none — everything relevant fit (nothing skipped for budget)
   *   low  — a little relevant memory was skipped (< half of what fit)
   *   high — as much or more relevant memory was skipped as was injected
   */
  budgetPressure: BudgetPressure;
}
