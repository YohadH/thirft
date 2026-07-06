/**
 * CompositeMemoryStore merges read-only memory sources with one writable store.
 *
 * The intended production shape is:
 *   - FileMemoryStore: read MEMORY.md / AGENTS.md / rules files live
 *   - JsonlStore: writable overlay for remember() and dashboard mutations
 */

import type { MemoryInput, MemoryRecord, Scope } from "../types.js";
import type { MemoryStore } from "./index.js";

export interface CompositeMemoryStoreOptions {
  /** The only store that receives writes. */
  writable: MemoryStore;
  /** Read-only or secondary memory sources merged into list/get reads. */
  sources?: MemoryStore[];
  /** Reload the writable store before reads when it supports reload(). Default true. */
  reloadWritableBeforeRead?: boolean;
}

type ReloadableStore = MemoryStore & { reload?: () => void };

export class CompositeMemoryStore implements MemoryStore {
  private readonly writable: MemoryStore;
  private readonly sources: MemoryStore[];
  private readonly reloadWritableBeforeRead: boolean;

  constructor(opts: CompositeMemoryStoreOptions) {
    this.writable = opts.writable;
    this.sources = opts.sources ?? [];
    this.reloadWritableBeforeRead = opts.reloadWritableBeforeRead ?? true;
  }

  add(input: MemoryInput, now: number): MemoryRecord {
    return this.writable.add(input, now);
  }

  get(id: string): MemoryRecord | undefined {
    this.refreshWritable();
    const overlay = this.writable.get(id);
    if (overlay) return overlay;
    for (const source of this.sources) {
      const record = source.get(id);
      if (record) return record;
    }
    return undefined;
  }

  update(
    id: string,
    patch: Partial<MemoryInput> & { disabled?: boolean },
    now: number,
  ): MemoryRecord | undefined {
    this.refreshWritable();
    return this.writable.update(id, patch, now);
  }

  remove(id: string): boolean {
    this.refreshWritable();
    return this.writable.remove(id);
  }

  list(filter?: { scope?: Scope; agentId?: string; sessionId?: string }): MemoryRecord[] {
    this.refreshWritable();
    const byId = new Map<string, MemoryRecord>();
    for (const source of this.sources) {
      for (const record of source.list(filter)) byId.set(record.id, record);
    }
    for (const record of this.writable.list(filter)) byId.set(record.id, record);
    return [...byId.values()];
  }

  private refreshWritable(): void {
    if (!this.reloadWritableBeforeRead) return;
    const store = this.writable as ReloadableStore;
    if (typeof store.reload === "function") store.reload();
  }
}
