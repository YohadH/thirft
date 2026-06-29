/**
 * ControlPanel — the owner's control plane over Thrift (M3).
 *
 * One object the owner-facing surface (HTTP server / CLI) drives to:
 *   - SEE every memory (with its scope, token cost, pinned/disabled state),
 *   - SEE per-agent + fleet token spend & savings (read from the meter log so it
 *     spans every run, not just this process),
 *   - ACT on memories: pin / unpin, disable / enable, edit, prune (delete),
 *   - ACT on agents: set a per-agent token budget, mute an agent,
 *   - flip the GLOBAL kill-switch.
 *
 * It owns no new persistence of its own: memories live in the MemoryStore, control
 * knobs in ControlSettings, savings in the meter JSONL. The panel just composes
 * them. Deterministic clock discipline holds — mutating ops take `now`.
 */

import type { MemoryStore } from "../store/index.js";
import type { MemoryRecord, Scope } from "../types.js";
import type { AgentRollup } from "../meter/index.js";
import { ControlSettings } from "./settings.js";
import { readMeterLog, rollupEventsByAgent } from "./meterLog.js";

/** A memory plus the panel-relevant flags, ready to render in the table. */
export interface MemoryRow {
  id: string;
  scope: Scope;
  agentId?: string;
  sessionId?: string;
  text: string;
  tags: string[];
  tokens: number;
  pinned: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Per-agent view: savings rollup + the owner's controls for that agent. */
export interface AgentView extends AgentRollup {
  /** Per-agent token-budget override, or null if none set. */
  budget: number | null;
  /** True if the owner has muted this agent. */
  disabled: boolean;
  /** Count of stored memories scoped directly to this agent. */
  memoryCount: number;
}

/** The whole-fleet summary card at the top of the panel. */
export interface FleetSummary {
  agents: number;
  runs: number;
  injectedTokens: number;
  baselineTokens: number;
  savedTokens: number;
  savingsRatio: number;
  memoryCount: number;
  /** True if the global kill-switch is engaged. */
  killSwitch: boolean;
}

export interface ControlPanelOptions {
  store: MemoryStore;
  settings: ControlSettings;
  /** Path to the JSONL meter log the MCP server / proxy append to. */
  meterLogPath?: string;
}

export class ControlPanel {
  private readonly store: MemoryStore;
  readonly settings: ControlSettings;
  private readonly meterLogPath?: string;

  constructor(opts: ControlPanelOptions) {
    this.store = opts.store;
    this.settings = opts.settings;
    this.meterLogPath = opts.meterLogPath;
  }

  // ── memories: view ──────────────────────────────────────────────────────────

  listMemories(filter?: { scope?: Scope; agentId?: string }): MemoryRow[] {
    return this.store
      .list(filter)
      .map(toRow)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; // pinned first
        return b.updatedAt - a.updatedAt; // then newest
      });
  }

  getMemory(id: string): MemoryRow | undefined {
    const r = this.store.get(id);
    return r ? toRow(r) : undefined;
  }

  // ── memories: act ───────────────────────────────────────────────────────────

  pin(id: string, now: number): MemoryRow | undefined {
    return this.applyPatch(id, { pinned: true }, now);
  }

  unpin(id: string, now: number): MemoryRow | undefined {
    return this.applyPatch(id, { pinned: false }, now);
  }

  disable(id: string, now: number): MemoryRow | undefined {
    return this.applyPatch(id, { disabled: true }, now);
  }

  enable(id: string, now: number): MemoryRow | undefined {
    return this.applyPatch(id, { disabled: false }, now);
  }

  /** Edit a memory's text and/or tags. Token cost is recomputed by the store. */
  edit(id: string, patch: { text?: string; tags?: string[] }, now: number): MemoryRow | undefined {
    return this.applyPatch(id, patch, now);
  }

  /** Prune (permanently delete) a memory. Returns true if one was removed. */
  prune(id: string): boolean {
    return this.store.remove(id);
  }

  private applyPatch(
    id: string,
    patch: Parameters<MemoryStore["update"]>[1],
    now: number,
  ): MemoryRow | undefined {
    const updated = this.store.update(id, patch, now);
    return updated ? toRow(updated) : undefined;
  }

  // ── savings: view ───────────────────────────────────────────────────────────

  /** Per-agent savings + controls, biggest savers first. `since` filters by time. */
  agentViews(since?: number): AgentView[] {
    const rollups = this.meterLogPath
      ? rollupEventsByAgent(readMeterLog(this.meterLogPath), since)
      : [];
    const memCounts = this.agentMemoryCounts();

    // Start from agents that have metering history…
    const byId = new Map<string, AgentView>();
    for (const r of rollups) {
      byId.set(r.agentId, {
        ...r,
        budget: this.settings.getAgentBudget(r.agentId) ?? null,
        disabled: this.settings.isAgentDisabled(r.agentId),
        memoryCount: memCounts.get(r.agentId) ?? 0,
      });
    }
    // …then fold in agents that only appear via stored memories or owner controls,
    // so the owner can manage an agent before its first metered run.
    const extra = new Set<string>([
      ...memCounts.keys(),
      ...Object.keys(this.settings.snapshot().agentBudgets),
      ...Object.keys(this.settings.snapshot().agentDisabled),
    ]);
    for (const agentId of extra) {
      if (byId.has(agentId)) continue;
      byId.set(agentId, {
        agentId,
        runs: 0,
        injectedTokens: 0,
        baselineTokens: 0,
        savedTokens: 0,
        savingsRatio: 0,
        budget: this.settings.getAgentBudget(agentId) ?? null,
        disabled: this.settings.isAgentDisabled(agentId),
        memoryCount: memCounts.get(agentId) ?? 0,
      });
    }
    return [...byId.values()].sort((a, b) => b.savedTokens - a.savedTokens);
  }

  fleetSummary(since?: number): FleetSummary {
    const events = this.meterLogPath ? readMeterLog(this.meterLogPath) : [];
    let injectedTokens = 0;
    let baselineTokens = 0;
    let runs = 0;
    const agents = new Set<string>();
    for (const e of events) {
      if (since !== undefined && e.at < since) continue;
      injectedTokens += e.injectedTokens;
      baselineTokens += e.baselineTokens;
      runs += 1;
      agents.add(e.agentId);
    }
    const savedTokens = baselineTokens - injectedTokens;
    return {
      agents: agents.size,
      runs,
      injectedTokens,
      baselineTokens,
      savedTokens,
      savingsRatio: baselineTokens === 0 ? 0 : savedTokens / baselineTokens,
      memoryCount: this.store.list().length,
      killSwitch: this.settings.isKilled(),
    };
  }

  // ── agent + global controls ──────────────────────────────────────────────────

  setAgentBudget(agentId: string, budget: number | undefined): void {
    this.settings.setAgentBudget(agentId, budget);
  }

  setAgentDisabled(agentId: string, disabled: boolean): void {
    this.settings.setAgentDisabled(agentId, disabled);
  }

  setKillSwitch(on: boolean): void {
    this.settings.setKillSwitch(on);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private agentMemoryCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const m of this.store.list({ scope: "agent" })) {
      if (!m.agentId) continue;
      counts.set(m.agentId, (counts.get(m.agentId) ?? 0) + 1);
    }
    return counts;
  }
}

function toRow(r: MemoryRecord): MemoryRow {
  return {
    id: r.id,
    scope: r.scope,
    agentId: r.agentId,
    sessionId: r.sessionId,
    text: r.text,
    tags: r.tags ?? [],
    tokens: r.tokens,
    pinned: r.pinned === true,
    disabled: r.disabled === true,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
