/**
 * Meter-log reader (M3).
 *
 * The in-memory meter is per-process; the JSONL meter log (THRIFT_METER_PATH,
 * written by the MCP server and the proxy) is the cross-run source of truth for
 * the control panel's savings view. This reads that file back into rollups so the
 * owner sees fleet-wide token spend & savings across every run, not just this one.
 *
 * Tolerant by construction: a missing file is "no data", and a malformed line is
 * skipped rather than crashing the panel. Pure — takes the path, returns data.
 */

import { existsSync, readFileSync } from "node:fs";
import type { AgentRollup } from "../meter/index.js";

/** One persisted metering event (the JSONL line shape the MCP server/proxy write). */
export interface PersistedMeterEvent {
  at: number;
  agentId: string;
  injectedTokens: number;
  baselineTokens: number;
  savedTokens: number;
  /** "proxy" when the event came from the gateway; absent for MCP recalls. */
  via?: string;
}

/** Parse the JSONL meter log into events. Missing file -> []. Bad lines skipped. */
export function readMeterLog(path: string): PersistedMeterEvent[] {
  if (!existsSync(path)) return [];
  const out: PersistedMeterEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<PersistedMeterEvent>;
      if (
        typeof e.agentId === "string" &&
        typeof e.injectedTokens === "number" &&
        typeof e.baselineTokens === "number"
      ) {
        out.push({
          at: typeof e.at === "number" ? e.at : 0,
          agentId: e.agentId,
          injectedTokens: e.injectedTokens,
          baselineTokens: e.baselineTokens,
          savedTokens:
            typeof e.savedTokens === "number"
              ? e.savedTokens
              : e.baselineTokens - e.injectedTokens,
          ...(typeof e.via === "string" ? { via: e.via } : {}),
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Roll persisted events up per agent (optionally within a [since, ∞) window). */
export function rollupEventsByAgent(
  events: readonly PersistedMeterEvent[],
  since?: number,
): AgentRollup[] {
  const byAgent = new Map<string, PersistedMeterEvent[]>();
  for (const e of events) {
    if (since !== undefined && e.at < since) continue;
    const list = byAgent.get(e.agentId) ?? [];
    list.push(e);
    byAgent.set(e.agentId, list);
  }
  return [...byAgent.entries()]
    .map(([agentId, evs]) => aggregate(agentId, evs))
    .sort((a, b) => b.savedTokens - a.savedTokens);
}

function aggregate(agentId: string, evs: PersistedMeterEvent[]): AgentRollup {
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
