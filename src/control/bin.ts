#!/usr/bin/env node
/**
 * Thrift control panel — standalone CLI binary (M3).
 *
 * The owner's control plane over the live memory store, savings meter, and
 * control knobs. It reads the SAME files the MCP server / proxy use, so a change
 * made here (pin/prune/mute/budget/kill) is honored by the next live recall.
 *
 * Usage:
 *   npm run start:panel -- summary
 *   npm run start:panel -- serve --port=8585
 *   npx thrift-panel memories --scope=agent
 *   npx thrift-panel kill on
 *
 * Path resolution (CLI flag > env var > default ~/.thrift/…):
 *   THRIFT_STORE_PATH   / --store-path=     memory store JSONL   (memories.jsonl)
 *   THRIFT_METER_PATH   / --meter-path=     metering log JSONL   (meter.jsonl)
 *   THRIFT_CONTROL_PATH / --control-path=   control settings JSON (control.json)
 *   THRIFT_PANEL_HOST   / --host=           browser UI host      (127.0.0.1)
 *   THRIFT_PANEL_PORT   / --port=           browser UI port      (8585)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { JsonlStore } from "../store/jsonlStore.js";
import { ControlSettings } from "./settings.js";
import { ControlPanel } from "./panel.js";
import { runCli } from "./cli.js";
import { startDashboardServer } from "./web.js";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const thriftDir = join(homedir(), ".thrift");

const storePath = flag("store-path") ?? process.env["THRIFT_STORE_PATH"] ?? join(thriftDir, "memories.jsonl");
const meterLogPath = flag("meter-path") ?? process.env["THRIFT_METER_PATH"] ?? join(thriftDir, "meter.jsonl");
const controlPath = flag("control-path") ?? process.env["THRIFT_CONTROL_PATH"] ?? join(thriftDir, "control.json");

const store = new JsonlStore({ path: storePath });
const settings = new ControlSettings({ path: controlPath });
const panel = new ControlPanel({ store, settings, meterLogPath });
const paths = { storePath, meterLogPath, controlPath };

// Strip the panel's own path flags before parsing the command, so they don't
// leak into command-level flags (e.g. `memories --scope=`).
const commandArgv = argv.filter(
  (a) => !a.startsWith("--store-path=") && !a.startsWith("--meter-path=") && !a.startsWith("--control-path="),
);

if (commandArgv[0] === "serve") {
  const host = flag("host") ?? process.env["THRIFT_PANEL_HOST"] ?? "127.0.0.1";
  const rawPort = flag("port") ?? process.env["THRIFT_PANEL_PORT"] ?? "8585";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`[thrift-panel] invalid --port=${rawPort}`);
    process.exit(1);
  }
  startDashboardServer({ panel, paths, host, port }).then(
    ({ url }) => {
      console.log(`[thrift-panel] dashboard: ${url}`);
      console.log(`[thrift-panel] store: ${storePath}`);
      console.log(`[thrift-panel] meter: ${meterLogPath}`);
    },
    (err: unknown) => {
      console.error("[thrift-panel] failed to start dashboard:", err);
      process.exit(1);
    },
  );
} else {
  const result = runCli(panel, commandArgv, Date.now());
  for (const line of result.out) console.log(line);
  process.exit(result.code);
}
