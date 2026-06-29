/**
 * Scoped retrieval (M1 — THIRFT-002).
 *
 * The core "smart filtering": replace "load all of MEMORY.md" with "load the
 * relevant slice". Given a RecallQuery, select memories that are (a) in scope
 * (org -> agent -> session), (b) tag/semantically relevant to the task, and
 * (c) fit under a hard token budget — pinned memories first.
 *
 * THIRFT-001 lays out the contract; THIRFT-002 implements the selection logic.
 */

import type { MemoryStore } from "../store/index.js";
import type { RecallQuery, RecallResult } from "../types.js";

export interface Retriever {
  /** Select the in-budget relevant slice for a recall, with a metering receipt. */
  recall(store: MemoryStore, query: RecallQuery): RecallResult;
}

// Concrete implementation (ScopedRetriever) lands in THIRFT-002.
