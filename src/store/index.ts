/**
 * Memory store (M1 — THIRFT-002).
 *
 * The store owns the lightweight write path: persist a memory cheaply with NO
 * mandatory LLM enrichment (the anti-MemClaw design). Backed by SQLite or a
 * JSONL file; this interface keeps callers agnostic of the backend.
 *
 * THIRFT-001 lays out the contract; THIRFT-002 implements it.
 */

import type { MemoryInput, MemoryRecord, Scope } from "../types.js";

export interface MemoryStore {
  /** Persist a new memory. Fast path — no embedding/enrichment required. */
  add(input: MemoryInput, now: number): MemoryRecord;
  /** Fetch a single memory by id, or undefined if absent. */
  get(id: string): MemoryRecord | undefined;
  /** Update mutable fields (text/tags/pinned/disabled) of an existing memory. */
  update(id: string, patch: Partial<MemoryInput> & { disabled?: boolean }, now: number): MemoryRecord | undefined;
  /** Remove a memory permanently. Returns true if something was deleted. */
  remove(id: string): boolean;
  /** List memories visible to a scope (optionally narrowed by agent/session). */
  list(filter?: { scope?: Scope; agentId?: string; sessionId?: string }): MemoryRecord[];
}

// Concrete implementations (SQLiteStore / JsonlStore) land in THIRFT-002.
