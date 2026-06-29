/**
 * Control plane (M3) — owner-facing controls over Thrift memory.
 *
 * Barrel for the M3 surface: the {@link ControlPanel} composition object, the
 * persisted {@link ControlSettings} knobs, the meter-log reader, and the CLI that
 * drives them. The CLI binary (`thrift-panel` / `npm run start:panel`) lives in
 * `bin.ts`.
 */

export type { ControlState, ControlSettingsOptions } from "./settings.js";
export { ControlSettings } from "./settings.js";

export type {
  MemoryRow,
  AgentView,
  FleetSummary,
  ControlPanelOptions,
} from "./panel.js";
export { ControlPanel } from "./panel.js";

export type { PersistedMeterEvent } from "./meterLog.js";
export { readMeterLog, rollupEventsByAgent } from "./meterLog.js";

export type { CliResult } from "./cli.js";
export { runCli } from "./cli.js";

export type {
  DashboardData,
  DashboardPaths,
  DashboardServerHandle,
  DashboardServerOptions,
  MemoryScopeCounts,
  SavingsPoint,
} from "./web.js";
export { buildDashboardData, startDashboardServer } from "./web.js";
