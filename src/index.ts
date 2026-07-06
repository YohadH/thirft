/**
 * Thrift — cost-first memory for AI agent fleets.
 *
 * Public API barrel. The write path is cheap (no mandatory LLM enrichment),
 * retrieval loads only the relevant slice under a hard token budget, and every
 * recall is metered against the full-context baseline so savings are provable.
 *
 * M1 (THIRFT-002/003) fills in the concrete Store/Retriever/Meter implementations
 * behind these exported contracts.
 */

export const VERSION = "0.0.7";

export type {
  Scope,
  MemoryRecord,
  MemoryInput,
  RecallQuery,
  RecallResult,
} from "./types.js";

export { estimateTokens, estimateTokensAll } from "./tokens.js";

export type { AuditFile, AuditOptions, AuditResult } from "./audit.js";
export { auditMemoryFiles, renderAudit } from "./audit.js";

export type { MemoryStore } from "./store/index.js";
export { JsonlStore } from "./store/jsonlStore.js";
export type { JsonlStoreOptions } from "./store/jsonlStore.js";
export { FileMemoryStore } from "./store/fileMemoryStore.js";
export type { FileMemoryStoreOptions } from "./store/fileMemoryStore.js";
export { CompositeMemoryStore } from "./store/compositeMemoryStore.js";
export type { CompositeMemoryStoreOptions } from "./store/compositeMemoryStore.js";

export type { Retriever } from "./retrieval/index.js";
export { ScopedRetriever } from "./retrieval/scopedRetriever.js";

export type { MeterEvent, AgentRollup, TokenMeter } from "./meter/index.js";
export { InMemoryMeter } from "./meter/inMemoryMeter.js";

export type {
  RememberArgs,
  RecallArgs,
  SearchMemoryArgs,
  ThriftMcpServerOptions,
} from "./mcp/server.js";
export { ThriftMcpServer } from "./mcp/server.js";

export type {
  ChatMessage,
  ChatRequest,
  TrimOptions,
  TrimResult,
} from "./proxy/contextTrim.js";
export { trimContext, contentToText } from "./proxy/contextTrim.js";

export type { ThriftProxyOptions, ProxyReceipt } from "./proxy/server.js";
export { ThriftProxy } from "./proxy/server.js";

export type { RateLimitOptions, FetchLike } from "./proxy/rateLimiter.js";
export { RateLimitHandler, rateLimitOptionsFromEnv } from "./proxy/rateLimiter.js";

// Control plane (M3) — owner-facing controls (kill-switch / budgets / pin / prune).
export type {
  ControlState,
  ControlSettingsOptions,
  MemoryRow,
  AgentView,
  FleetSummary,
  ControlPanelOptions,
  PersistedMeterEvent,
  CliResult,
  DashboardData,
  DashboardPaths,
  DashboardServerHandle,
  DashboardServerOptions,
  MemoryScopeCounts,
  SavingsPoint,
} from "./control/index.js";
export {
  ControlSettings,
  ControlPanel,
  readMeterLog,
  rollupEventsByAgent,
  runCli,
  buildDashboardData,
  startDashboardServer,
} from "./control/index.js";
