/**
 * ControlSettings — the owner's persisted control knobs (M3).
 *
 * The control panel needs state the memory store doesn't carry: a GLOBAL
 * kill-switch (stop injecting memory fleet-wide), PER-AGENT token budgets (cap an
 * agent's recall regardless of what it requests), and a PER-AGENT disable (mute a
 * single agent's recalls). These live in a small JSON config file, separate from
 * the memory JSONL log, so the owner can edit/version them independently.
 *
 * Cost-first + deterministic, like the rest of Thrift: the file is a single small
 * JSON object rewritten whole on change (config is tiny — no append-log needed),
 * and nothing here reads the wall clock.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The owner's control state. All optional — absent means "default/off". */
export interface ControlState {
  /** Global kill-switch: when true, NO memory is injected for ANY agent. */
  killSwitch: boolean;
  /** Per-agent hard token budget overrides (agentId -> max tokens per recall). */
  agentBudgets: Record<string, number>;
  /** Per-agent kill-switch (agentId -> true means that agent gets zero injection). */
  agentDisabled: Record<string, boolean>;
}

export interface ControlSettingsOptions {
  /** File to persist to. Omit for an in-memory-only settings store (tests). */
  path?: string;
}

const EMPTY: ControlState = { killSwitch: false, agentBudgets: {}, agentDisabled: {} };

export class ControlSettings {
  private state: ControlState;
  private readonly path?: string;

  constructor(opts: ControlSettingsOptions = {}) {
    this.path = opts.path;
    this.state = this.load();
  }

  /** A snapshot of the full control state (safe to serialize to the panel). */
  snapshot(): ControlState {
    return {
      killSwitch: this.state.killSwitch,
      agentBudgets: { ...this.state.agentBudgets },
      agentDisabled: { ...this.state.agentDisabled },
    };
  }

  // ── global kill-switch ─────────────────────────────────────────────────────

  isKilled(): boolean {
    return this.state.killSwitch;
  }

  setKillSwitch(on: boolean): void {
    this.state.killSwitch = on;
    this.persist();
  }

  // ── per-agent budgets ──────────────────────────────────────────────────────

  /** Set (or, with `undefined`, clear) an agent's token-budget override. */
  setAgentBudget(agentId: string, budget: number | undefined): void {
    if (budget === undefined) {
      delete this.state.agentBudgets[agentId];
    } else {
      if (!Number.isFinite(budget) || budget < 0) {
        throw new Error(`agent budget must be a non-negative number, got ${budget}`);
      }
      this.state.agentBudgets[agentId] = Math.floor(budget);
    }
    this.persist();
  }

  getAgentBudget(agentId: string): number | undefined {
    return this.state.agentBudgets[agentId];
  }

  // ── per-agent disable ──────────────────────────────────────────────────────

  setAgentDisabled(agentId: string, disabled: boolean): void {
    if (disabled) this.state.agentDisabled[agentId] = true;
    else delete this.state.agentDisabled[agentId];
    this.persist();
  }

  isAgentDisabled(agentId: string): boolean {
    return this.state.agentDisabled[agentId] === true;
  }

  /**
   * Resolve the EFFECTIVE token budget for a recall, applying the owner's
   * controls on top of the budget the agent requested:
   *   - global kill-switch on   -> 0 (no injection at all)
   *   - this agent disabled      -> 0
   *   - per-agent budget set     -> min(requested, agentBudget) (the tighter wins)
   *   - otherwise                -> requested unchanged
   *
   * Returning 0 makes recall inject nothing (the greedy packer admits nothing),
   * while still computing the honest baseline — so the savings receipt shows the
   * full cost the owner avoided by muting that agent.
   */
  effectiveBudget(agentId: string, requested: number): number {
    if (this.state.killSwitch) return 0;
    if (this.isAgentDisabled(agentId)) return 0;
    const cap = this.state.agentBudgets[agentId];
    if (cap !== undefined) return Math.min(requested, cap);
    return requested;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private load(): ControlState {
    if (!this.path || !existsSync(this.path)) return { ...EMPTY, agentBudgets: {}, agentDisabled: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ControlState>;
      return {
        killSwitch: raw.killSwitch === true,
        agentBudgets: raw.agentBudgets ?? {},
        agentDisabled: raw.agentDisabled ?? {},
      };
    } catch {
      // A corrupt config must never wedge the panel — fall back to defaults.
      return { ...EMPTY, agentBudgets: {}, agentDisabled: {} };
    }
  }

  private persist(): void {
    if (!this.path) return;
    const dir = dirname(this.path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2) + "\n");
  }
}
