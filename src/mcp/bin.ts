#!/usr/bin/env node
/**
 * Thrift MCP server — standalone stdio binary (plus utility subcommands).
 *
 * Usage:
 *   npx thrift-memory                 # start MCP server (~/.thrift/memories.jsonl, budget 2000)
 *   npx thrift-memory --store-path=/my/path/memories.jsonl --default-budget=4000
 *   npx thrift-memory audit           # scan this repo for agent memory files, report the token waste
 *   npx thrift-memory session-context # print a budgeted memory slice (for SessionStart hooks)
 *
 * Subcommand flags:
 *   audit:            --path= --sessions= --budget= --price-per-mtok=
 *   session-context:  --budget= --agent-id= --store-path= --meter-path=
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

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { JsonlStore } from "../store/jsonlStore.js";
import { ScopedRetriever } from "../retrieval/scopedRetriever.js";
import { InMemoryMeter } from "../meter/inMemoryMeter.js";
import { ControlSettings } from "../control/settings.js";
import { auditMemoryFiles, renderAudit } from "../audit.js";
import { buildSessionContext } from "../sessionContext.js";
import { ThriftMcpServer } from "./server.js";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function intFlag(name: string, fallback: number): number {
  const raw = flag(name);
  const v = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) ? v : fallback;
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

// ── subcommand dispatch (before the MCP server starts) ───────────────────────
const positional = argv.filter((a) => !a.startsWith("--"));

if (positional[0] === "audit") {
  const root = resolve(flag("path") ?? process.cwd());
  const result = auditMemoryFiles(root, {
    sessionsPerDay: intFlag("sessions", 10),
    tokenBudget: intFlag("budget", 2_000),
    pricePerMTok: intFlag("price-per-mtok", 15),
    homeDir: homedir(),
  });
  for (const line of renderAudit(result)) console.log(line);
  process.exit(0);
}

if (positional[0] === "session-context") {
  // Hook contract: stdout is injected into the session's context; empty store →
  // print nothing; NEVER exit non-zero for data problems (a failing SessionStart
  // hook must not degrade the user's session).
  try {
    const { lines, result } = buildSessionContext(
      new JsonlStore({ path: storePath }),
      new ScopedRetriever(),
      {
        agentId: flag("agent-id") ?? "session-start",
        tokenBudget: intFlag("budget", 1_500),
      },
    );
    for (const line of lines) console.log(line);
    if (result) {
      try {
        mkdirSync(dirname(meterLogPath), { recursive: true });
        appendFileSync(
          meterLogPath,
          JSON.stringify({
            at: Date.now(),
            agentId: flag("agent-id") ?? "session-start",
            injectedTokens: result.injectedTokens,
            baselineTokens: result.baselineTokens,
            savedTokens: result.savedTokens,
            via: "session-start",
          }) + "\n",
        );
      } catch {
        /* metering must never break the hook */
      }
    }
  } catch (err) {
    console.error("[thrift-memory] session-context:", err instanceof Error ? err.message : err);
  }
  process.exit(0);
}

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
