/**
 * InMemoryMeter — the headline "provable savings" feature (M1 — THIRFT-003).
 *
 * Logs every recall's tokens-injected vs the full-context baseline, then rolls
 * the events up per-agent and fleet-wide. This is what turns "Thrift is cheaper"
 * into a number: savedTokens and savingsRatio across the real fleet.
 *
 * In-memory by default; a recall result feeds straight in via `recordRecall`.
 * Persistence/DB rollups belong to M3 (control panel) — this keeps the hot path
 * cheap, matching the cost-first design.
 */

import type { AgentRollup, MeterEvent, TokenMeter } from "./index.js";
import type { RecallResult } from "../types.js";

export class InMemoryMeter implements TokenMeter {
  private readonly events: MeterEvent[] = [];

  record(event: MeterEvent): void {
    this.events.push(event);
  }

  /** Convenience: meter a recall result directly (the common call site). */
  recordRecall(agentId: string, at: number, result: RecallResult): void {
    this.record({
      at,
      agentId,
      injectedTokens: result.injectedTokens,
      baselineTokens: result.baselineTokens,
    });
  }

  rollupByAgent(agentId: string, since?: number): AgentRollup {
    return aggregate(
      agentId,
      this.events.filter((e) => e.agentId === agentId && inWindow(e, since)),
    );
  }

  rollupFleet(since?: number): AgentRollup[] {
    const byAgent = new Map<string, MeterEvent[]>();
    for (const e of this.events) {
      if (!inWindow(e, since)) continue;
      const list = byAgent.get(e.agentId) ?? [];
      list.push(e);
      byAgent.set(e.agentId, list);
    }
    return [...byAgent.entries()]
      .map(([agentId, evs]) => aggregate(agentId, evs))
      .sort((a, b) => b.savedTokens - a.savedTokens); // biggest savers first
  }

  /** Raw events (e.g. for the control panel to persist/inspect). */
  all(): readonly MeterEvent[] {
    return this.events;
  }
}

function inWindow(e: MeterEvent, since?: number): boolean {
  return since === undefined || e.at >= since;
}

function aggregate(agentId: string, evs: MeterEvent[]): AgentRollup {
  let injectedTokens = 0;
  let baselineTokens = 0;
  for (const e of evs) {
    injectedTokens += e.injectedTokens;
    baselineTokens += e.baselineTokens;
  }
  const savedTokens = baselineTokens - injectedTokens;
  return {
    agentId,
    runs: evs.length,
    injectedTokens,
    baselineTokens,
    savedTokens,
    savingsRatio: baselineTokens === 0 ? 0 : savedTokens / baselineTokens,
  };
}
