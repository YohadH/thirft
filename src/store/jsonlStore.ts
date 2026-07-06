/**
 * JsonlStore — the lightweight write path (M1 — THIRFT-002).
 *
 * In-memory index with optional append-on-write JSONL persistence. This is the
 * "anti-MemClaw" path: a write is a cheap object insert + one line appended to a
 * file. No embedding, no LLM enrichment, no graph build on the hot path.
 *
 * "SQLite/file" per the task: we use a file (JSONL) rather than SQLite to avoid a
 * native (node-gyp) dependency on Windows. The MemoryStore interface keeps the
 * backend swappable — a SqliteStore can drop in later without touching callers.
 *
 * Thrift never reads the wall clock itself: callers pass `now` (epoch millis).
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { MemoryStore } from "./index.js";
import type { MemoryInput, MemoryRecord, Scope } from "../types.js";
import { estimateTokens } from "../tokens.js";

/** A persisted operation. Replayed in order to rebuild state on load. */
type LogEntry =
  | { op: "put"; record: MemoryRecord }
  | { op: "del"; id: string };

export interface JsonlStoreOptions {
  /** File to persist to. Omit for a pure in-memory store (tests, ephemeral runs). */
  path?: string;
}

export class JsonlStore implements MemoryStore {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly path?: string;
  private readonly skippedLines: number[] = [];

  constructor(opts: JsonlStoreOptions = {}) {
    this.path = opts.path;
    if (this.path) this.load();
  }

  /**
   * Re-read the persisted log from disk. This lets a long-running MCP server see
   * updates made by another process, such as `thrift-panel` pin/disable/prune.
   */
  reload(): void {
    if (!this.path) return;
    this.records.clear();
    this.skippedLines.length = 0;
    this.load();
  }

  add(input: MemoryInput, now: number): MemoryRecord {
    validateScope(input.scope, input);
    const record: MemoryRecord = {
      id: randomUUID(),
      scope: input.scope,
      agentId: input.agentId,
      sessionId: input.sessionId,
      text: input.text,
      tags: input.tags,
      pinned: input.pinned ?? false,
      disabled: false,
      tokens: estimateTokens(input.text),
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    this.append({ op: "put", record });
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  update(
    id: string,
    patch: Partial<MemoryInput> & { disabled?: boolean },
    now: number,
  ): MemoryRecord | undefined {
    const existing = this.records.get(id);
    if (!existing) return undefined;

    const next: MemoryRecord = {
      ...existing,
      ...("scope" in patch && patch.scope ? { scope: patch.scope } : {}),
      ...("agentId" in patch ? { agentId: patch.agentId } : {}),
      ...("sessionId" in patch ? { sessionId: patch.sessionId } : {}),
      ...("tags" in patch ? { tags: patch.tags } : {}),
      ...("pinned" in patch ? { pinned: patch.pinned } : {}),
      ...("disabled" in patch ? { disabled: patch.disabled } : {}),
      ...("text" in patch && patch.text !== undefined
        ? { text: patch.text, tokens: estimateTokens(patch.text) }
        : {}),
      updatedAt: now,
    };
    validateScope(next.scope, next);

    this.records.set(id, next);
    this.append({ op: "put", record: next });
    return next;
  }

  remove(id: string): boolean {
    const existed = this.records.delete(id);
    if (existed) this.append({ op: "del", id });
    return existed;
  }

  list(filter?: { scope?: Scope; agentId?: string; sessionId?: string }): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    for (const r of this.records.values()) {
      if (filter?.scope && r.scope !== filter.scope) continue;
      if (filter?.agentId && r.agentId !== filter.agentId) continue;
      if (filter?.sessionId && r.sessionId !== filter.sessionId) continue;
      out.push(r);
    }
    return out;
  }

  // --- persistence ---------------------------------------------------------

  private append(entry: LogEntry): void {
    if (!this.path) return;
    this.ensureDir();
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    const raw = readFileSync(this.path, "utf8");
    let lineNo = 0;
    for (const line of raw.split("\n")) {
      lineNo++;
      if (!line.trim()) continue;
      // A single corrupt line (e.g. a half-written record from a crash mid-append)
      // must not brick the whole store. Skip it and keep replaying the rest.
      let entry: LogEntry;
      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        this.skippedLines.push(lineNo);
        continue;
      }
      if (entry && entry.op === "put") this.records.set(entry.record.id, entry.record);
      else if (entry && entry.op === "del") this.records.delete(entry.id);
    }
  }

  /** Line numbers skipped during load() because they failed to parse (corrupt log lines). */
  get corruptLinesSkipped(): number[] {
    return [...this.skippedLines];
  }

  /**
   * Rewrite the log as one "put" per live record, dropping tombstones and
   * superseded versions. Keeps an append-only log from growing unbounded.
   */
  compact(): void {
    if (!this.path) return;
    this.ensureDir();
    const lines = [...this.records.values()].map(
      (record) => JSON.stringify({ op: "put", record } satisfies LogEntry),
    );
    writeFileSync(this.path, lines.length ? lines.join("\n") + "\n" : "");
  }

  private ensureDir(): void {
    if (!this.path) return;
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function validateScope(scope: Scope, m: { agentId?: string; sessionId?: string }): void {
  if (scope === "agent" && !m.agentId) {
    throw new Error("agent-scoped memory requires agentId");
  }
  if (scope === "session" && !m.sessionId) {
    throw new Error("session-scoped memory requires sessionId");
  }
}
