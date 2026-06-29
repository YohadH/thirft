#!/usr/bin/env node
/**
 * Thrift MCP server — standalone stdio binary.
 *
 * Usage:
 *   npx thrift-memory           # uses ~/.thrift/memories.jsonl, budget 2000
 *   npx thrift-memory --store-path=/my/path/memories.jsonl --default-budget=4000
 *
 * Env vars (lower precedence than CLI flags):
 *   THRIFT_STORE_PATH      path to JSONL store file
 *   THRIFT_DEFAULT_BUDGET  default token budget for recall (integer)
 *   THRIFT_METER_PATH      path to JSONL metering log (injected/baseline/saved tokens per recall)
 *   THRIFT_CONTROL_PATH    path to the control-panel settings JSON (kill-switch / per-agent budgets+mutes)
 *
 * Claude Desktop / Claude Code config example:
 *   {
 *     "mcpServers": {
 *       "thrift": { "command": "npx", "args": ["thrift-memory"] }
 *     }
 *   }
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { JsonlStore } from "../store/jsonlStore.js";
import { ScopedRetriever } from "../retrieval/scopedRetriever.js";
import { InMemoryMeter } from "../meter/inMemoryMeter.js";
import { ControlSettings } from "../control/settings.js";
import { ThriftMcpServer } from "./server.js";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const storePath =
  flag("store-path") ??
  process.env["THRIFT_STORE_PATH"] ??
  join(homedir(), ".thrift", "memories.jsonl");

const rawBudget = flag("default-budget") ?? process.env["THRIFT_DEFAULT_BUDGET"];
const defaultTokenBudget = rawBudget ? parseInt(rawBudget, 10) : 2_000;

// Where to persist per-recall metering (so a dashboard can show the token flow). Default next to the store.
const meterLogPath =
  flag("meter-path") ??
  process.env["THRIFT_METER_PATH"] ??
  join(homedir(), ".thrift", "meter.jsonl");

// The control-panel settings file is the SAME one `thrift-panel` writes, so the
// owner's kill-switch / per-agent budgets / mutes set via the panel bite here at
// recall time. Re-read on each recall so a panel change takes effect without a
// server restart (the file is tiny — a single small JSON object).
const controlPath =
  flag("control-path") ??
  process.env["THRIFT_CONTROL_PATH"] ??
  join(homedir(), ".thrift", "control.json");

const store = new JsonlStore({ path: storePath });
const retriever = new ScopedRetriever();
const meter = new InMemoryMeter();
const server = new ThriftMcpServer({
  store,
  retriever,
  meter,
  defaultTokenBudget,
  meterLogPath,
  resolveBudget: (agentId, requested) =>
    new ControlSettings({ path: controlPath }).effectiveBudget(agentId, requested),
});

server.runStdio().catch((err: unknown) => {
  console.error("[thrift-mcp] fatal:", err);
  process.exit(1);
});
