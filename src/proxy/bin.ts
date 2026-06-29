#!/usr/bin/env node
/**
 * Thrift proxy/gateway — standalone HTTP binary (THIRFT-M2b).
 *
 * Drop-in cost-cutting proxy. Point your agent's base_url at this process and it
 * trims context under a token budget, meters the savings, and forwards upstream.
 *
 * Usage:
 *   node dist/proxy/bin.js --upstream=https://api.anthropic.com --port=8787 --budget=4000
 *
 * Then in your agent set the API base URL to http://localhost:8787 and keep your
 * real API key — Thrift forwards your auth headers untouched.
 *
 * Env vars (lower precedence than CLI flags):
 *   THRIFT_UPSTREAM_URL    upstream LLM API base URL (default https://api.anthropic.com)
 *   THRIFT_PROXY_HOST      host/interface to bind (default 127.0.0.1 — local only)
 *   THRIFT_PROXY_PORT      port to listen on (default 8787)
 *   THRIFT_PROXY_BUDGET    hard token budget for forwarded context (default 4000)
 *   THRIFT_METER_PATH      path to JSONL metering log (injected/baseline/saved per request)
 *
 * Security: binds to 127.0.0.1 by default because the proxy forwards your real
 * provider API key upstream. Set --host=0.0.0.0 only if you deliberately want to
 * expose it (e.g. inside a trusted private network).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryMeter } from "../meter/inMemoryMeter.js";
import { ThriftProxy } from "./server.js";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

const upstreamBaseUrl =
  flag("upstream") ?? process.env["THRIFT_UPSTREAM_URL"] ?? "https://api.anthropic.com";

const host = flag("host") ?? process.env["THRIFT_PROXY_HOST"] ?? "127.0.0.1";

const rawPort = flag("port") ?? process.env["THRIFT_PROXY_PORT"];
const port = rawPort ? parseInt(rawPort, 10) : 8787;

const rawBudget = flag("budget") ?? process.env["THRIFT_PROXY_BUDGET"];
const tokenBudget = rawBudget ? parseInt(rawBudget, 10) : 4_000;

const meterLogPath =
  flag("meter-path") ?? process.env["THRIFT_METER_PATH"] ?? join(homedir(), ".thrift", "meter.jsonl");

const meter = new InMemoryMeter();
const proxy = new ThriftProxy({ upstreamBaseUrl, tokenBudget, meter, meterLogPath });

proxy
  .listen(port, host)
  .then((bound) => {
    console.error(
      `[thrift-proxy] listening on http://${host}:${bound} → ${upstreamBaseUrl} ` +
        `(budget ${tokenBudget} tok, meter ${meterLogPath})`,
    );
  })
  .catch((err: unknown) => {
    console.error("[thrift-proxy] fatal:", err);
    process.exit(1);
  });
