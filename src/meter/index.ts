/**
 * Token meter (M1 — THIRFT-003).
 *
 * The headline feature: every injection logs tokens-injected vs the full-context
 * baseline, so savings are provable. Rolls up per-agent, per-day, and fleet-wide.
 *
 * THIRFT-001 lays out the contract; THIRFT-003 implements the logging + rollups.
 */

export interface MeterEvent {
  /** Epoch millis (caller-supplied; Thrift never reads the wall clock). */
  at: number;
  /** Agent this recall served. */
  agentId: string;
  /** Tokens actually injected this recall. */
  injectedTokens: number;
  /** Tokens the naive full-context baseline would have injected. */
  baselineTokens: number;
  /**
   * Quality-pairing fields (THRIFT-QUALITY-PAIRING). Optional so existing rows
   * and callers stay valid.
   *
   * 'full' = full context loaded (baseline run), 'thin' = thrift recall used.
   */
  mode?: "full" | "thin";
  /** Which board task this run was serving (for A/B pairing). */
  taskId?: string;
  /** Agent-reported outcome: 'pass' | 'needs-fix' | 'error' | string. */
  outcome?: string;
  /**
   * True when this row was produced by a synthetic harness rather than a real
   * production recall. Analysis tools can exclude these rows for real-only
   * reports. Optional: real recall rows omit it entirely.
   */
  synthetic?: boolean;
}

export interface AgentRollup {
  agentId: string;
  runs: number;
  injectedTokens: number;
  baselineTokens: number;
  savedTokens: number;
  /** savedTokens / baselineTokens, 0..1. */
  savingsRatio: number;
}

export interface TokenMeter {
  /** Record one recall's metering event. */
  record(event: MeterEvent): void;
  /** Aggregate savings for one agent (optionally within a time window). */
  rollupByAgent(agentId: string, since?: number): AgentRollup;
  /** Aggregate savings across the whole fleet. */
  rollupFleet(since?: number): AgentRollup[];
}

// Concrete implementation lands in THIRFT-003.
