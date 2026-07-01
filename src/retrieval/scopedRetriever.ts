/**
 * ScopedRetriever — the core "smart filtering" (M1 — THIRFT-002).
 *
 * Replaces "load all of MEMORY.md" with "load the relevant slice":
 *   1. Scope   — gather memories visible to the requesting agent:
 *                org (shared by the whole fleet) + this agent + this session.
 *   2. Filter  — drop disabled memories; if the query carries tags, keep only
 *                memories that share a tag (pinned memories bypass the tag filter).
 *   3. Rank    — score by lexical overlap with the task text; pinned get a big
 *                boost so they win first claim on the budget; ties break on recency.
 *   4. Pack    — greedily admit memories while staying under the HARD token budget.
 *
 * The receipt reports injected vs baseline ("load everything in scope") tokens,
 * which is what makes the savings provable.
 */

import type { MemoryStore } from "../store/index.js";
import type { Retriever } from "./index.js";
import type { MemoryRecord, RecallQuery, RecallResult } from "../types.js";

const PIN_BOOST = 1_000_000;

export class ScopedRetriever implements Retriever {
  recall(store: MemoryStore, query: RecallQuery): RecallResult {
    const candidates = this.inScope(store, query).filter((m) => !m.disabled);

    const taggable = query.tags?.length
      ? candidates.filter((m) => m.pinned || sharesTag(m.tags, query.tags!))
      : candidates;

    // Baseline = what a naive "load everything in scope" would have injected.
    // This is the FULL in-scope (non-disabled) set, BEFORE any tag filtering:
    // tag filtering is part of Thrift's smart selection, so the tokens it drops
    // must count toward the savings. Computing the baseline from the tag-filtered
    // subset (`taggable`) understates savings whenever a tag filter is active and
    // makes the receipt misleading (THIRFT-BUG-001).
    const baselineTokens = sum(candidates.map((m) => m.tokens));

    const queryTerms = terms(query.task ?? "");
    const ranked = [...taggable].sort((a, b) => {
      const sa = score(a, queryTerms);
      const sb = score(b, queryTerms);
      if (sb !== sa) return sb - sa;
      return b.updatedAt - a.updatedAt; // newer first on ties
    });

    // Relevance floor: when the task carries query terms, a memory must actually
    // be relevant (>=1 term overlap) or pinned to be injected. Without this, any
    // zero-overlap memory rides in just because it fits the budget — diluting the
    // slice with noise and inflating injectedTokens with context the agent didn't
    // need. With no task text there's nothing to match on, so we fall back to the
    // recency-ordered pack (the floor is disabled). Pinned memories always pass
    // (score includes PIN_BOOST). Baseline stays the full in-scope set, so dropping
    // an irrelevant memory honestly counts as savings, not a hidden narrowing.
    const applyFloor = queryTerms.size > 0;

    const selected: MemoryRecord[] = [];
    let injectedTokens = 0;
    // `relevantTokens` is every memory that CLEARS the relevance floor — the
    // context worth injecting before the budget bites. Tracking it (vs what we
    // actually injected) is what tells the agent whether the budget, not
    // relevance, is what held memory back. Irrelevant memories never count here,
    // so "more relevant memory exists" can't be triggered by noise.
    let relevantTokens = 0;
    let skippedForBudget = 0;
    for (const m of ranked) {
      if (applyFloor && score(m, queryTerms) === 0) continue; // not relevant, not pinned
      relevantTokens += m.tokens;
      if (injectedTokens + m.tokens > query.tokenBudget) {
        skippedForBudget += 1; // relevant, but the budget couldn't fit it
        continue;
      }
      selected.push(m);
      injectedTokens += m.tokens;
    }

    const skippedTokensForBudget = relevantTokens - injectedTokens;

    return {
      memories: selected,
      injectedTokens,
      baselineTokens,
      savedTokens: baselineTokens - injectedTokens,
      relevantTokens,
      skippedForBudget,
      skippedTokensForBudget,
      hasMoreRelevantMemory: skippedForBudget > 0,
      budgetPressure: pressure(injectedTokens, skippedTokensForBudget),
    };
  }

  private inScope(store: MemoryStore, query: RecallQuery): MemoryRecord[] {
    const org = store.list({ scope: "org" });
    const agent = store.list({ scope: "agent", agentId: query.agentId });
    const session = query.sessionId
      ? store.list({ scope: "session", sessionId: query.sessionId })
      : [];
    return [...org, ...agent, ...session];
  }
}

/**
 * Classify budget pressure from what was injected vs what relevant memory the
 * budget dropped. `none` = everything relevant fit; `high` = at least as much
 * relevant memory was dropped as injected (including the "got nothing" case);
 * `low` = some was dropped but less than what fit.
 */
function pressure(injectedTokens: number, skippedTokensForBudget: number): "none" | "low" | "high" {
  if (skippedTokensForBudget <= 0) return "none";
  if (skippedTokensForBudget >= injectedTokens) return "high";
  return "low";
}

function score(m: MemoryRecord, queryTerms: Set<string>): number {
  let s = m.pinned ? PIN_BOOST : 0;
  if (queryTerms.size === 0) return s;
  const text = terms(m.text);
  for (const t of m.tags ?? []) text.add(t.toLowerCase());
  for (const qt of queryTerms) if (text.has(qt)) s += 1;
  return s;
}

function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2) out.add(w); // skip noise words / punctuation
  }
  return out;
}

function sharesTag(a: string[] | undefined, b: string[]): boolean {
  if (!a?.length) return false;
  const set = new Set(a);
  return b.some((t) => set.has(t));
}

function sum(ns: number[]): number {
  let t = 0;
  for (const n of ns) t += n;
  return t;
}
