import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ControlPanel } from "./panel.js";
import { readMeterLog } from "./meterLog.js";
import type { PersistedMeterEvent } from "./meterLog.js";

export interface DashboardPaths {
  storePath: string;
  meterLogPath: string;
  controlPath: string;
}

export interface SavingsPoint {
  day: string;
  runs: number;
  baselineTokens: number;
  injectedTokens: number;
  savedTokens: number;
  savingsRatio: number;
}

export interface MemoryScopeCounts {
  org: number;
  agent: number;
  session: number;
  unknown: number;
}

export interface DashboardData {
  generatedAt: number;
  paths: DashboardPaths;
  summary: ReturnType<ControlPanel["fleetSummary"]>;
  agents: ReturnType<ControlPanel["agentViews"]>;
  memories: ReturnType<ControlPanel["listMemories"]>;
  memoryScopes: MemoryScopeCounts;
  recentEvents: PersistedMeterEvent[];
  trend: SavingsPoint[];
}

export interface DashboardServerOptions {
  panel: ControlPanel;
  paths: DashboardPaths;
  host?: string;
  port?: number;
}

export interface DashboardServerHandle {
  server: Server;
  url: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8585;
const MAX_MEMORIES = 1000;
const MAX_EVENTS = 50;
const MAX_BODY_BYTES = 64 * 1024;

export function buildDashboardData(panel: ControlPanel, paths: DashboardPaths, now: number): DashboardData {
  const events = readMeterLog(paths.meterLogPath);
  const memories = panel.listMemories();
  return {
    generatedAt: now,
    paths,
    summary: panel.fleetSummary(),
    agents: panel.agentViews(),
    memories: memories.slice(0, MAX_MEMORIES),
    memoryScopes: countMemoryScopes(memories),
    recentEvents: [...events].sort((a, b) => b.at - a.at).slice(0, MAX_EVENTS),
    trend: dailyTrend(events).slice(-30),
  };
}

export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;

  const server = createServer((req, res) => {
    routeDashboardRequest(opts.panel, opts.paths, req, res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({ server, url: `http://${host}:${address.port}` });
    });
  });
}

/**
 * Route every request the dashboard serves. GET serves the single-page UI and the
 * read-only `/api/dashboard` snapshot. The write surface (memory pin/disable/prune,
 * per-agent budget/mute, the global kill-switch) is exposed as small POST/DELETE
 * endpoints that drive the existing ControlPanel — every one of which persists to
 * the same JSONL store / control.json the live recall path reads.
 */
export function routeDashboardRequest(
  panel: ControlPanel,
  paths: DashboardPaths,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const path = url.pathname;

  // ── reads (GET) ────────────────────────────────────────────────────────────
  if (method === "GET") {
    if (path === "/" || path === "/index.html") {
      sendHtml(res, dashboardHtml());
      return;
    }
    if (path === "/api/dashboard") {
      sendJson(res, 200, buildDashboardData(panel, paths, Date.now()));
      return;
    }
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // ── writes (POST / DELETE) ───────────────────────────────────────────────────
  if (method === "POST" || method === "DELETE") {
    handleWrite(panel, method, path, req, res);
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
}

function handleWrite(
  panel: ControlPanel,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // POST /api/killswitch  { on: boolean }
  // Turning the kill-switch ON disables recall fleet-wide, so it requires
  // body { confirm: true } (mirrors DELETE /api/memory/:id). Turning it OFF is
  // a recovery action and needs no confirmation.
  if (method === "POST" && path === "/api/killswitch") {
    readBody(req, res, (body) => {
      const on = body?.on === true;
      if (on && body?.confirm !== true) {
        sendJson(res, 400, { error: "confirm_required" });
        return;
      }
      panel.setKillSwitch(on);
      sendJson(res, 200, { ok: true, killSwitch: on });
    });
    return;
  }

  // POST /api/memory/:id/pin  -> toggles pinned
  let m = matchPath(path, /^\/api\/memory\/([^/]+)\/pin$/);
  if (method === "POST" && m) {
    const id = safeDecode(m);
    if (id === null) return badPathSegment(res);
    const current = panel.getMemory(id);
    if (!current) return notFound(res);
    const row = current.pinned ? panel.unpin(id, Date.now()) : panel.pin(id, Date.now());
    sendJson(res, 200, { ok: true, pinned: row?.pinned ?? false });
    return;
  }

  // POST /api/memory/:id/disable  -> toggles disabled
  m = matchPath(path, /^\/api\/memory\/([^/]+)\/disable$/);
  if (method === "POST" && m) {
    const id = safeDecode(m);
    if (id === null) return badPathSegment(res);
    const current = panel.getMemory(id);
    if (!current) return notFound(res);
    const row = current.disabled ? panel.enable(id, Date.now()) : panel.disable(id, Date.now());
    sendJson(res, 200, { ok: true, disabled: row?.disabled ?? false });
    return;
  }

  // DELETE /api/memory/:id  -> prune (permanent). Guard: body { confirm: true }.
  m = matchPath(path, /^\/api\/memory\/([^/]+)$/);
  if (method === "DELETE" && m) {
    const id = safeDecode(m);
    if (id === null) return badPathSegment(res);
    readBody(req, res, (body) => {
      if (body?.confirm !== true) {
        sendJson(res, 400, { error: "confirm_required" });
        return;
      }
      const removed = panel.prune(id);
      if (!removed) return notFound(res);
      sendJson(res, 200, { ok: true, pruned: id });
    });
    return;
  }

  // POST /api/agent/:id/budget  { budget: number | null }
  m = matchPath(path, /^\/api\/agent\/([^/]+)\/budget$/);
  if (method === "POST" && m) {
    const agentId = safeDecode(m);
    if (agentId === null) return badPathSegment(res);
    readBody(req, res, (body) => {
      const raw = body?.budget;
      if (raw === null || raw === undefined) {
        panel.setAgentBudget(agentId, undefined);
        sendJson(res, 200, { ok: true, budget: null });
        return;
      }
      const budget = Number(raw);
      if (!Number.isFinite(budget) || budget < 0) {
        sendJson(res, 400, { error: "invalid_budget" });
        return;
      }
      panel.setAgentBudget(agentId, budget);
      sendJson(res, 200, { ok: true, budget: Math.floor(budget) });
    });
    return;
  }

  // POST /api/agent/:id/mute  { disabled: boolean }
  m = matchPath(path, /^\/api\/agent\/([^/]+)\/mute$/);
  if (method === "POST" && m) {
    const agentId = safeDecode(m);
    if (agentId === null) return badPathSegment(res);
    readBody(req, res, (body) => {
      const disabled = body?.disabled === true;
      panel.setAgentDisabled(agentId, disabled);
      sendJson(res, 200, { ok: true, disabled });
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function matchPath(path: string, re: RegExp): string | null {
  const m = re.exec(path);
  return m ? m[1] : null;
}

/**
 * Decode a URL path segment, returning `null` on a malformed escape sequence.
 * `decodeURIComponent` throws a `URIError` on input like `%`, `%zz`, or a lone
 * surrogate; left uncaught it would escape the per-endpoint handlers and surface
 * as a misleading 500. Callers treat `null` as a 400 Bad Request.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function badPathSegment(res: ServerResponse): void {
  sendJson(res, 400, { error: "bad_request" });
}

/** Read & JSON-parse a small request body, capped to guard against abuse. */
function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  cb: (body: Record<string, unknown> | null) => void,
): void {
  let size = 0;
  const chunks: Buffer[] = [];
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: "payload_too_large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      cb(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      cb(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
    }
  });
  req.on("error", () => {
    if (!aborted) sendJson(res, 400, { error: "read_error" });
  });
}

function sendHtml(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function countMemoryScopes(memories: ReturnType<ControlPanel["listMemories"]>): MemoryScopeCounts {
  const counts: MemoryScopeCounts = { org: 0, agent: 0, session: 0, unknown: 0 };
  for (const memory of memories) {
    if (memory.scope === "org" || memory.scope === "agent" || memory.scope === "session") {
      counts[memory.scope] += 1;
    } else {
      counts.unknown += 1;
    }
  }
  return counts;
}

function dailyTrend(events: readonly PersistedMeterEvent[]): SavingsPoint[] {
  const byDay = new Map<string, SavingsPoint>();
  for (const event of events) {
    const day = dayKey(event.at);
    const current = byDay.get(day) ?? {
      day,
      runs: 0,
      baselineTokens: 0,
      injectedTokens: 0,
      savedTokens: 0,
      savingsRatio: 0,
    };
    current.runs += 1;
    current.baselineTokens += event.baselineTokens;
    current.injectedTokens += event.injectedTokens;
    current.savedTokens = current.baselineTokens - current.injectedTokens;
    current.savingsRatio = current.baselineTokens === 0 ? 0 : current.savedTokens / current.baselineTokens;
    byDay.set(day, current);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function dayKey(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  return new Date(at).toISOString().slice(0, 10);
}

function dashboardHtml(): string {
  return DASHBOARD_HTML;
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thrift — Savings Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
  <style>
    :root {
      color-scheme: dark;

      --bg:            #0a0d0f;
      --surface:       #111518;
      --surface-2:     #181d21;
      --border:        #252c31;
      --border-strong: #3a444b;

      --ink:           #d4dce2;
      --muted:         #586168;
      --faint:         #2d3539;

      --accent:        #00d4a4;
      --accent-dim:    rgba(0, 212, 164, 0.12);
      --positive:      #3dd68c;

      --warn:          #d4a017;
      --warn-dim:      rgba(212, 160, 23, 0.10);

      --danger:        #e5534b;
      --danger-dim:    rgba(229, 83, 75, 0.12);

      --kill-bg:       #1e0c0b;
      --kill-border:   #6e2320;

      --font: 'IBM Plex Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, monospace;

      --radius: 0px;
      --radius-sm: 2px;
    }

    * { box-sizing: border-box; }

    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: var(--font);
      background: var(--bg);
      color: var(--ink);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    /* scanline texture */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 2px,
        rgba(0, 0, 0, 0.08) 2px,
        rgba(0, 0, 0, 0.08) 4px
      );
      pointer-events: none;
      z-index: 0;
    }
    button, input, select { font: inherit; color: inherit; }
    code { font-family: var(--font); }
    [hidden] { display: none !important; }
    ::placeholder { color: var(--muted); }

    /* ── Shell ───────────────────────────────────────────────────────────── */
    .shell {
      display: flex;
      min-height: 100vh;
      position: relative;
      z-index: 1;
    }

    /* ── Sidebar ─────────────────────────────────────────────────────────── */
    .sidebar {
      width: 180px;
      flex: none;
      border-right: 1px solid var(--border);
      background: var(--surface);
      display: flex;
      flex-direction: column;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .side-logo {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 18px 16px;
      border-bottom: 1px solid var(--border);
    }
    .logo-mark { width: 14px; height: 14px; background: var(--accent); flex: none; }
    .logo-text strong { display: block; font-size: 15px; font-weight: 600; line-height: 1.1; }
    .logo-text span { display: block; font-size: 10px; color: var(--muted); margin-top: 1px; }
    .side-nav { display: flex; flex-direction: column; padding: 12px 0; flex: 1; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 16px;
      color: var(--muted);
      text-decoration: none;
      border-left: 2px solid transparent;
      font-size: 13px;
      cursor: pointer;
      transition: color 80ms, background 80ms;
    }
    .nav-item .nav-ic { width: 14px; text-align: center; flex: none; opacity: 0.85; }
    .nav-item:hover { color: var(--ink); background: rgba(255, 255, 255, 0.03); }
    .nav-item.is-active {
      color: var(--ink);
      border-left: 2px solid var(--accent);
      background: var(--accent-dim);
      padding-left: 14px;
    }
    .nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .side-foot {
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      font-size: 10px;
      color: var(--faint);
      display: grid;
      gap: 3px;
    }
    .side-foot .store-path { word-break: break-all; }

    /* ── Main ────────────────────────────────────────────────────────────── */
    .main { flex: 1; min-width: 0; overflow-y: auto; }
    .content { max-width: 1360px; margin: 0 auto; padding: 32px 40px; }
    .view { display: none; }
    .view.is-active { display: block; }

    /* ── Page title row ──────────────────────────────────────────────────── */
    .page-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .page-head h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.12em;
      color: var(--ink);
    }
    .page-head .subline { margin: 5px 0 0; font-size: 12px; color: var(--muted); }
    .page-head .count { font-size: 12px; color: var(--muted); font-weight: 400; letter-spacing: 0.04em; }
    .head-actions { display: flex; align-items: center; gap: 14px; }
    .status-line { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .status-line.is-error { color: var(--danger); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
    .status-dot.is-live { background: var(--positive); animation: blink 1s ease-in-out 3; }
    .status-dot.is-error { background: var(--danger); }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

    .button {
      border: 1px solid var(--border-strong);
      background: transparent;
      color: var(--ink);
      font-size: 12px;
      padding: 6px 14px;
      cursor: pointer;
      letter-spacing: 0.05em;
      border-radius: var(--radius);
    }
    .button:hover { border-color: var(--accent); color: var(--accent); }
    .button:active { transform: scale(0.97); }
    .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* ── Metric cards ────────────────────────────────────────────────────── */
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 24px; }
    .metric { border: 1px solid var(--border); background: var(--surface); padding: 16px; min-height: 130px; display: flex; flex-direction: column; }
    .metric--hero { border-top: 2px solid var(--accent); }
    .metric .m-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .metric .m-value { font-size: 30px; font-weight: 600; line-height: 1.05; margin-top: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .metric--hero .m-value { font-size: clamp(40px, 6.5vw, 70px); color: var(--accent); }
    .metric--saved .m-value { color: var(--positive); }
    .metric .m-note { font-size: 11px; color: var(--muted); margin-top: 8px; min-height: 14px; }
    .metric .m-note.is-kill { color: var(--danger); font-weight: 600; }
    .metric .m-note.is-ok { color: var(--positive); }

    /* ── Panels ──────────────────────────────────────────────────────────── */
    .panel { background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
    .panel-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--surface-2);
    }
    .panel-title { font-size: 12px; font-weight: 600; color: var(--ink); text-transform: uppercase; letter-spacing: 0.08em; }
    .panel-meta { font-size: 11px; color: var(--muted); }

    .grid2 { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .grid2 + .grid2 { margin-top: 16px; }
    .side-stack { display: grid; gap: 16px; }

    /* ── Chart ───────────────────────────────────────────────────────────── */
    .chart { height: 240px; padding: 20px 16px 32px; position: relative; }
    .chart svg { width: 100%; height: 100%; display: block; }
    .chart-legend { position: absolute; left: 20px; bottom: 8px; display: flex; gap: 16px; font-size: 11px; color: var(--muted); }
    .chart-legend .lg { display: inline-flex; align-items: center; gap: 6px; }
    .lg-sq { width: 8px; height: 8px; flex: none; }
    .chart-tip {
      position: absolute; z-index: 6; min-width: 180px; padding: 9px 11px;
      background: var(--surface-2); border: 1px solid var(--border-strong);
      color: var(--ink); font-size: 12px; pointer-events: none; opacity: 0;
      transform: translate(-50%, -10px); transition: opacity 110ms ease;
    }
    .chart-tip.is-on { opacity: 1; }
    .chart-tip strong { display: block; margin-bottom: 6px; font-size: 12px; }
    .tip-row { display: flex; justify-content: space-between; gap: 18px; line-height: 1.5; }
    .tip-row span:first-child { color: var(--muted); }
    .tip-row span:last-child { font-variant-numeric: tabular-nums; }

    /* ── Scopes ──────────────────────────────────────────────────────────── */
    .scope-bars { padding: 14px 16px; display: grid; gap: 11px; }
    .scope-row { display: grid; grid-template-columns: 66px 1fr 40px; gap: 10px; align-items: center; font-size: 12px; }
    .scope-name { color: var(--ink); }
    .scope-count { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
    .bar { height: 6px; background: var(--border); overflow: hidden; }
    .bar > span { display: block; height: 100%; background: var(--accent); }
    .bar-fill--org { background: var(--accent); }
    .bar-fill--agent { background: var(--warn); }
    .bar-fill--session { background: var(--muted); }
    .bar-fill--unknown { background: var(--faint); }

    /* ── Paths ───────────────────────────────────────────────────────────── */
    .paths { padding: 14px 16px; display: grid; gap: 12px; }
    .path-row { display: grid; gap: 3px; }
    .path-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); }
    .path-value { font-size: 11px; color: var(--muted); word-break: break-all; }

    /* ── Tables ──────────────────────────────────────────────────────────── */
    .table-wrap { overflow: auto; max-height: 400px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: middle; }
    thead th {
      position: sticky; top: 0; z-index: 1;
      background: var(--surface-2); color: var(--muted);
      font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.08em;
    }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    tbody tr:hover { background: rgba(0, 212, 164, 0.04); }
    td code { font-size: 12px; color: var(--ink); }
    .c-base { color: var(--warn); }
    .c-inj { color: var(--muted); }
    .c-saved { color: var(--positive); }
    .c-pct { color: var(--accent); font-weight: 600; }
    .share-cell { min-width: 120px; }
    .table-empty { text-align: center; color: var(--muted); padding: 22px 12px; }

    /* ── Receipts ────────────────────────────────────────────────────────── */
    .events { max-height: 320px; overflow: auto; }
    .event {
      display: flex; justify-content: space-between; align-items: center; gap: 10px;
      padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 12px;
    }
    .event:last-child { border-bottom: 0; }
    .event:hover { background: var(--surface-2); }
    .event-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .event-agent { color: var(--ink); }
    .event-time { color: var(--muted); font-size: 11px; }
    .pill {
      flex: none; color: var(--positive); background: var(--accent-dim);
      border: 1px solid rgba(0, 212, 164, 0.2); border-radius: var(--radius-sm);
      font-size: 12px; padding: 2px 8px; white-space: nowrap; font-variant-numeric: tabular-nums;
    }

    /* ── Filter bar (memories) ───────────────────────────────────────────── */
    .filter-bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .search-input {
      width: 280px; max-width: 100%; padding: 8px 12px; font-size: 13px;
      background: var(--surface-2); border: 1px solid var(--border); color: var(--ink); border-radius: var(--radius);
    }
    .search-input:focus { outline: none; border-color: var(--accent); }
    .scope-tabs { display: flex; gap: 6px; }
    .scope-tab {
      padding: 6px 12px; font-size: 12px; background: transparent; cursor: pointer;
      border: 1px solid var(--border); color: var(--muted); border-radius: var(--radius);
    }
    .scope-tab:hover { color: var(--ink); }
    .scope-tab.is-active { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); }
    .tag-select {
      padding: 7px 10px; font-size: 12px; background: var(--surface-2);
      border: 1px solid var(--border); color: var(--ink); border-radius: var(--radius); cursor: pointer;
    }
    .tag-select:focus { outline: none; border-color: var(--accent); }

    /* ── Scope badge / tag pill ──────────────────────────────────────────── */
    .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
    .badge--org { background: var(--warn-dim); color: var(--warn); border-color: rgba(212, 160, 23, 0.25); }
    .badge--agent { background: var(--accent-dim); color: var(--accent); border-color: rgba(0, 212, 164, 0.25); }
    .badge--session { background: var(--surface-2); color: var(--muted); border-color: var(--border); }
    .badge--unknown { background: var(--surface-2); color: var(--faint); border-color: var(--border); }
    .tagp { display: inline-block; font-size: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1px 6px; color: var(--muted); margin-right: 4px; }

    .mem-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; color: var(--ink); }
    td.mem-text-cell { width: 100%; max-width: 360px; white-space: normal; }
    .mem-expand { background: var(--surface-2); border-top: 1px solid var(--border); padding: 12px 16px; font-size: 12px; color: var(--ink); white-space: pre-wrap; word-break: break-word; }
    .ico-btn {
      width: 28px; height: 28px; line-height: 1; display: inline-grid; place-items: center;
      background: transparent; border: 1px solid transparent; color: var(--muted); cursor: pointer; border-radius: var(--radius); font-size: 14px;
    }
    .ico-btn:hover { border-color: var(--border); color: var(--ink); }
    .ico-btn.is-on-pin { color: var(--accent); }
    .ico-btn.is-on-dis { color: var(--warn); }
    .ico-btn.btn-prune:hover { color: var(--danger); border-color: var(--danger); }
    .status-ico { font-size: 13px; }
    .status-ico.on-pin { color: var(--accent); }
    .status-ico.off { color: var(--faint); }
    .status-ico.on-dis { color: var(--danger); }
    .confirm-inline { display: inline-flex; gap: 6px; align-items: center; font-size: 11px; color: var(--danger); }
    .confirm-inline button { font-size: 11px; padding: 2px 8px; cursor: pointer; background: transparent; border: 1px solid var(--border); color: var(--ink); }
    .confirm-inline button.yes:hover { border-color: var(--danger); color: var(--danger); }
    .load-more { display: block; margin: 16px auto 0; }

    /* ── Empty / ASCII ───────────────────────────────────────────────────── */
    .empty-box { text-align: center; color: var(--muted); padding: 40px 16px; }
    .ascii { color: var(--faint); white-space: pre; font-size: 12px; line-height: 1.3; margin-bottom: 12px; }
    .empty-box .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
    .empty-box code { color: var(--accent); }

    /* ── Skeleton (loading) ──────────────────────────────────────────────── */
    .skeleton { color: transparent !important; border-radius: 0; position: relative; }
    .skeleton::after {
      content: ''; position: absolute; inset: 2px 0;
      background: var(--surface-2); animation: pulse-sk 1.2s ease-in-out infinite;
    }
    .metric .m-value.skeleton::after { inset: 4px 30% 4px 0; }
    @keyframes pulse-sk { 0%, 100% { background: var(--surface-2); } 50% { background: var(--surface); } }
    .sk-row td { height: 36px; }
    .sk-bar { display: block; height: 12px; background: var(--surface-2); animation: pulse-sk 1.2s ease-in-out infinite; }

    /* ── Agents page ─────────────────────────────────────────────────────── */
    .kill-card { border: 1px solid var(--border); background: var(--surface); padding: 18px 20px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
    .kill-card.is-on { background: var(--kill-bg); border-color: var(--kill-border); }
    .kill-info h2 { margin: 0 0 6px; font-size: 14px; font-weight: 600; letter-spacing: 0.06em; }
    .kill-info p { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
    .kill-card.is-on .kill-info h2, .kill-card.is-on .kill-info p { color: var(--danger); }
    .kill-toggle-wrap { display: flex; align-items: center; gap: 12px; flex: none; }
    .kill-state { font-size: 11px; letter-spacing: 0.08em; color: var(--muted); }
    .kill-card.is-on .kill-state { color: var(--danger); }

    .toggle { position: relative; width: 44px; height: 24px; flex: none; border: 1px solid var(--border); background: var(--surface-2); cursor: pointer; padding: 0; transition: background 200ms, border-color 200ms; }
    .toggle .knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: var(--ink); transition: transform 200ms; }
    .toggle[aria-checked="true"] { background: var(--danger); border-color: var(--danger); }
    .toggle[aria-checked="true"] .knob { transform: translateX(20px); background: #fff; }
    .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .toggle--sm { width: 36px; height: 20px; }
    .toggle--sm .knob { width: 14px; height: 14px; }
    .toggle--sm[aria-checked="true"] { background: var(--warn); border-color: var(--warn); }
    .toggle--sm[aria-checked="true"] .knob { transform: translateX(16px); }

    .agent-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .agent-card { border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; }
    .agent-card:hover { border-color: var(--border-strong); }
    .agent-card.is-muted { border-color: var(--kill-border); }
    .ac-head { padding: 14px 16px; border-bottom: 1px solid var(--border); }
    .ac-id { font-size: 14px; font-weight: 700; color: var(--ink); word-break: break-all; }
    .ac-id .muted-suffix { color: var(--warn); font-weight: 400; font-size: 11px; }
    .ac-runs { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .ac-body { padding: 14px 16px; display: grid; gap: 8px; }
    .ac-saved { font-size: 20px; font-weight: 600; color: var(--positive); }
    .ac-saved.is-zero { color: var(--muted); font-size: 13px; font-weight: 400; }
    .ac-tokens { font-size: 11px; color: var(--muted); }
    .ac-foot { padding: 12px 16px; border-top: 1px solid var(--border); display: grid; gap: 10px; }
    .ac-ctl { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); }
    .budget-input { width: 84px; padding: 4px 8px; font-size: 12px; background: transparent; border: 1px solid var(--border); color: var(--ink); border-radius: var(--radius); text-align: right; font-variant-numeric: tabular-nums; }
    .budget-input:focus { outline: none; border-color: var(--accent); }

    /* ── Banners ─────────────────────────────────────────────────────────── */
    .banner { padding: 10px 16px; font-size: 12px; border: 1px solid; margin-bottom: 16px; }
    .banner--warn { background: var(--warn-dim); color: var(--warn); border-color: rgba(212, 160, 23, 0.3); }
    .banner--error { background: var(--danger-dim); color: var(--danger); border-color: var(--danger); }
    .banner code { color: inherit; }

    /* ── Mobile nav strip (hidden by default) ────────────────────────────── */
    .mobile-nav { display: none; }

    /* ── Responsive ──────────────────────────────────────────────────────── */
    @media (max-width: 1099px) {
      .grid2 { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .agent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .content { padding: 28px 28px; }
    }
    @media (max-width: 859px) {
      .sidebar { width: 44px; }
      .logo-text, .nav-label, .side-foot { display: none; }
      .side-logo { justify-content: center; padding: 16px 0; }
      .nav-item { justify-content: center; padding: 10px 0; }
      .nav-item.is-active { padding-left: 0; }
      .nav-item .nav-ic { width: auto; }
    }
    @media (max-width: 599px) {
      .shell { flex-direction: column; }
      .sidebar { width: 100%; height: auto; flex-direction: row; position: sticky; top: 0; z-index: 5; border-right: 0; border-bottom: 1px solid var(--border); }
      .side-logo { border-bottom: 0; border-right: 1px solid var(--border); }
      .side-nav { flex-direction: row; padding: 0; flex: 1; }
      .nav-item { border-left: 0; border-bottom: 2px solid transparent; flex: 1; }
      .nav-item.is-active { border-left: 0; border-bottom: 2px solid var(--accent); }
      .metrics { grid-template-columns: 1fr; }
      .agent-grid { grid-template-columns: 1fr; }
      .content { padding: 20px 16px; }
      .kill-card { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="side-logo">
        <span class="logo-mark" aria-hidden="true"></span>
        <span class="logo-text"><strong>Thrift</strong><span>cost-first</span></span>
      </div>
      <nav class="side-nav" aria-label="Primary">
        <a class="nav-item" href="#overview" data-nav="overview"><span class="nav-ic" aria-hidden="true">▣</span><span class="nav-label">Overview</span></a>
        <a class="nav-item" href="#memories" data-nav="memories"><span class="nav-ic" aria-hidden="true">≡</span><span class="nav-label">Memories</span></a>
        <a class="nav-item" href="#agents" data-nav="agents"><span class="nav-ic" aria-hidden="true">◉</span><span class="nav-label">Agents</span></a>
      </nav>
      <div class="side-foot">
        <span>v0.1.0</span>
        <span class="store-path" id="storePathFoot">~/.thrift/</span>
      </div>
    </aside>

    <main class="main">
      <div class="content">
        <!-- ───────────────── Overview ───────────────── -->
        <section class="view" data-view="overview">
          <div class="page-head">
            <div>
              <h1>SAVINGS DASHBOARD</h1>
              <p class="subline">Live totals from the MCP/proxy meter log.</p>
            </div>
            <div class="head-actions">
              <span class="status-line" id="statusLine"><span class="status-dot" id="statusDot"></span><span id="statusText">Loading…</span></span>
              <button class="button" id="refreshBtn" type="button">Refresh</button>
            </div>
          </div>

          <div class="banner banner--warn" id="killBanner" role="alert" hidden>
            KILL-SWITCH is ON — Thrift is serving no recalls. Toggle it off on the <a href="#agents" style="color:inherit;text-decoration:underline">Agents</a> page.
          </div>
          <div class="banner banner--error" id="errorBanner" role="alert" hidden></div>

          <section class="metrics" aria-label="Fleet metrics">
            <div class="metric metric--hero">
              <div class="m-label">Savings Rate</div>
              <div class="m-value skeleton" id="mSavingsRate">--</div>
              <div class="m-note" id="mSavingsNote">saved / baseline tokens</div>
            </div>
            <div class="metric metric--saved">
              <div class="m-label">Saved Tokens</div>
              <div class="m-value skeleton" id="mSaved">--</div>
              <div class="m-note" id="mSavedNote">baseline → injected</div>
            </div>
            <div class="metric">
              <div class="m-label">Metered Runs</div>
              <div class="m-value skeleton" id="mRuns">--</div>
              <div class="m-note" id="mRunsNote">metered agents</div>
            </div>
            <div class="metric">
              <div class="m-label">Memories</div>
              <div class="m-value skeleton" id="mMemories">--</div>
              <div class="m-note is-ok" id="mMemNote">kill-switch OFF</div>
            </div>
          </section>

          <div class="grid2">
            <div class="panel">
              <div class="panel-head"><span class="panel-title">Daily Token Flow</span><span class="panel-meta">last 30 active days</span></div>
              <div class="chart" id="chart"></div>
            </div>
            <div class="side-stack">
              <div class="panel">
                <div class="panel-head"><span class="panel-title">Memory Scopes</span><span class="panel-meta" id="scopeMeta">stored records</span></div>
                <div class="scope-bars" id="scopeBars"></div>
              </div>
              <div class="panel">
                <div class="panel-head"><span class="panel-title">Audit Paths</span><span class="panel-meta">local files</span></div>
                <div class="paths" id="paths"></div>
              </div>
            </div>
          </div>

          <div class="grid2">
            <div class="panel">
              <div class="panel-head"><span class="panel-title">Agent Savings</span><span class="panel-meta" id="agentCount">--</span></div>
              <div class="table-wrap">
                <table>
                  <thead><tr>
                    <th scope="col">Agent</th>
                    <th scope="col" class="num">Runs</th>
                    <th scope="col" class="num">Baseline</th>
                    <th scope="col" class="num">Injected</th>
                    <th scope="col" class="num">Saved</th>
                    <th scope="col" class="num">Save%</th>
                    <th scope="col" class="share-cell">Share</th>
                  </tr></thead>
                  <tbody id="agentRows"></tbody>
                </table>
              </div>
            </div>
            <div class="panel">
              <div class="panel-head"><span class="panel-title">Recent Receipts</span><span class="panel-meta">meter log</span></div>
              <div class="events" id="events"></div>
            </div>
          </div>
        </section>

        <!-- ───────────────── Memories ───────────────── -->
        <section class="view" data-view="memories">
          <div class="page-head">
            <div>
              <h1>MEMORY STORE <span class="count" id="memCount"></span></h1>
              <p class="subline">Browse, search, and manage every stored memory.</p>
            </div>
          </div>
          <div class="filter-bar" id="memFilters">
            <input class="search-input" id="memSearch" type="search" placeholder="Search memories…" aria-label="Search memories">
            <div class="scope-tabs" id="memScopeTabs" role="tablist">
              <button class="scope-tab is-active" data-scope="all" role="tab">All</button>
              <button class="scope-tab" data-scope="org" role="tab">org</button>
              <button class="scope-tab" data-scope="agent" role="tab">agent</button>
              <button class="scope-tab" data-scope="session" role="tab">session</button>
            </div>
            <select class="tag-select" id="memTag" aria-label="Filter by tag"><option value="">All tags</option></select>
          </div>
          <div class="panel">
            <div class="table-wrap" style="max-height:600px">
              <table>
                <thead><tr>
                  <th scope="col">Scope</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Text</th>
                  <th scope="col" class="num">Tokens</th>
                  <th scope="col">Tags</th>
                  <th scope="col" style="text-align:center">Status</th>
                  <th scope="col" style="text-align:right">Actions</th>
                </tr></thead>
                <tbody id="memRows"></tbody>
              </table>
            </div>
          </div>
          <button class="button load-more" id="memLoadMore" type="button" hidden>Load more</button>
        </section>

        <!-- ───────────────── Agents ───────────────── -->
        <section class="view" data-view="agents">
          <div class="page-head">
            <div>
              <h1>AGENT CONTROLS <span class="count" id="agCount"></span></h1>
              <p class="subline">Per-agent budgets and the global kill-switch.</p>
            </div>
          </div>
          <div class="kill-card" id="killCard">
            <div class="kill-info">
              <h2 id="killTitle">GLOBAL KILL-SWITCH</h2>
              <p id="killDesc">Disables all recall operations fleet-wide. Agents fall back to loading full context.</p>
            </div>
            <div class="kill-toggle-wrap">
              <span class="kill-state" id="killState">OFF</span>
              <button class="toggle" id="killToggle" role="switch" aria-checked="false" aria-label="Global kill-switch" tabindex="0"><span class="knob"></span></button>
            </div>
          </div>
          <div class="agent-grid" id="agentCards"></div>
        </section>
      </div>
    </main>
  </div>

  <script>
  (function () {
    "use strict";
    var fmt = new Intl.NumberFormat();
    var pct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
    var qs = function (id) { return document.getElementById(id); };
    var SCOPE_ORDER = ["org", "agent", "session", "unknown"];

    function esc(v) {
      if (v == null) return "";
      return String(v).replace(/[&<>"']/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
      });
    }
    function compactTokens(n) {
      if (!isFinite(n)) return "0";
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (Math.abs(n) >= 1e4) return Math.round(n / 1e3) + "K";
      return fmt.format(n);
    }
    function monthDay(day) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
      return m ? m[2] + "-" + m[3] : (day || "");
    }
    function relTime(ms) {
      if (!isFinite(ms) || ms <= 0) return "unknown";
      var d = Date.now() - ms;
      if (d < 60000) return "just now";
      if (d < 3600000) return Math.floor(d / 60000) + " min ago";
      if (d < 86400000) return Math.floor(d / 3600000) + " hr ago";
      return new Date(ms).toLocaleDateString();
    }

    var state = { data: null, memScope: "all", memSearch: "", memTag: "", memLimit: 100 };

    /* ── routing ──────────────────────────────────────────────── */
    function renderView() {
      var view = (location.hash.replace("#", "") || "overview");
      if (["overview", "memories", "agents"].indexOf(view) === -1) view = "overview";
      var sections = document.querySelectorAll(".view");
      for (var i = 0; i < sections.length; i++) {
        sections[i].classList.toggle("is-active", sections[i].getAttribute("data-view") === view);
      }
      var navs = document.querySelectorAll(".nav-item");
      for (var j = 0; j < navs.length; j++) {
        navs[j].classList.toggle("is-active", navs[j].getAttribute("data-nav") === view);
      }
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", renderView);

    /* ── count-up animation ───────────────────────────────────── */
    function countUp(el, target, fmtFn, delay) {
      var start = 0, dur = 1200, t0 = null;
      var ease = function (x) { return 1 - Math.pow(1 - x, 3); };
      function frame(t) {
        if (t0 === null) t0 = t;
        var p = Math.min(1, (t - t0) / dur);
        el.textContent = fmtFn(start + (target - start) * ease(p));
        if (p < 1) requestAnimationFrame(frame);
        else el.textContent = fmtFn(target);
      }
      setTimeout(function () { requestAnimationFrame(frame); }, delay || 0);
    }

    function clearSkeletons() {
      var els = document.querySelectorAll(".skeleton");
      for (var i = 0; i < els.length; i++) els[i].classList.remove("skeleton");
    }

    /* ── overview: metric cards ───────────────────────────────── */
    function renderMetrics(s) {
      var empty = s.runs === 0 && s.baselineTokens === 0;
      clearSkeletons();
      if (empty) {
        qs("mSavingsRate").textContent = "--";
        qs("mSaved").textContent = "0";
        qs("mRuns").textContent = "0";
        qs("mMemories").textContent = fmt.format(s.memoryCount);
        qs("mSavingsNote").textContent = "No meter events yet.";
        qs("mSavedNote").textContent = "no receipts";
        qs("mRunsNote").textContent = "0 metered agents";
      } else {
        countUp(qs("mSavingsRate"), s.savingsRatio || 0, function (v) { return pct.format(v); }, 0);
        countUp(qs("mSaved"), s.savedTokens, function (v) { return compactTokens(v); }, 150);
        countUp(qs("mRuns"), s.runs, function (v) { return fmt.format(Math.round(v)); }, 300);
        countUp(qs("mMemories"), s.memoryCount, function (v) { return fmt.format(Math.round(v)); }, 450);
        qs("mSavingsNote").textContent = compactTokens(s.savedTokens) + " saved of " + compactTokens(s.baselineTokens) + " baseline";
        qs("mSavedNote").textContent = "baseline " + compactTokens(s.baselineTokens) + " → injected " + compactTokens(s.injectedTokens);
        qs("mRunsNote").textContent = fmt.format(s.agents) + " metered agents";
      }
      var note = qs("mMemNote");
      if (s.killSwitch) { note.textContent = "KILL-SWITCH ON"; note.className = "m-note is-kill"; }
      else { note.textContent = "kill-switch OFF"; note.className = "m-note is-ok"; }
    }

    /* ── overview: chart (grouped columns) ────────────────────── */
    function renderChart(points) {
      var el = qs("chart");
      if (!points || !points.length) {
        el.innerHTML = '<div class="empty-box"><div class="ascii">' +
          esc("+----------------+\n|  NO METER DATA |\n+----------------+") +
          '</div><div>No meter events yet.</div><div class="hint">Run the MCP server and make some <code>recall()</code> calls.</div></div>';
        return;
      }
      var W = 760, H = 220, padL = 44, padR = 16, padT = 14, padB = 34;
      var plotW = W - padL - padR, plotH = H - padT - padB;
      var max = Math.max.apply(null, points.map(function (p) { return p.baselineTokens; }).concat([1]));
      var n = points.length;
      var slot = plotW / n;
      var barW = Math.max(3, Math.min(18, slot / 2.6));
      var y = function (v) { return padT + plotH - (v / max) * plotH; };
      var rotate = n > 10;

      var ticks = [0, 0.33, 0.66, 1];
      var grid = ticks.map(function (t) {
        var gy = y(max * t);
        return '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="#252c31" stroke-width="1" stroke-dasharray="3 3"></line>' +
          '<text x="' + (padL - 6) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="10" fill="#586168">' + compactTokens(Math.round(max * t)) + '</text>';
      }).join("");

      var bars = "", labels = "";
      var lblEvery = n > 18 ? 3 : (n > 10 ? 2 : 1);
      points.forEach(function (p, i) {
        var cx = padL + slot * i + slot / 2;
        var bx = y(p.baselineTokens), jx = y(p.injectedTokens);
        // saved background fill (gap)
        bars += '<rect x="' + (cx - barW - 1) + '" y="' + bx + '" width="' + (barW * 2 + 2) + '" height="' + (padT + plotH - bx) + '" fill="rgba(0,212,164,0.12)"></rect>';
        bars += '<rect x="' + (cx - barW - 1) + '" y="' + bx + '" width="' + barW + '" height="' + (padT + plotH - bx) + '" fill="#d4a017"></rect>';
        bars += '<rect x="' + (cx + 1) + '" y="' + jx + '" width="' + barW + '" height="' + (padT + plotH - jx) + '" fill="#00d4a4"></rect>';
        var label = p.day + ': runs ' + p.runs + ', baseline ' + fmt.format(p.baselineTokens) + ', injected ' + fmt.format(p.injectedTokens) + ', saved ' + fmt.format(p.savedTokens);
        bars += '<rect class="hit" data-i="' + i + '" x="' + (cx - slot / 2) + '" y="' + padT + '" width="' + slot + '" height="' + plotH + '" fill="transparent" tabindex="0" role="button" aria-label="' + esc(label) + '" style="cursor:crosshair"></rect>';
        if (i % lblEvery === 0 || i === n - 1) {
          var tx = cx, ty = H - 18;
          var tr = rotate ? ' transform="rotate(-45 ' + tx + ' ' + ty + ')"' : "";
          var anchor = rotate ? "end" : "middle";
          labels += '<text x="' + tx + '" y="' + ty + '" text-anchor="' + anchor + '" font-size="10" fill="#586168"' + tr + '>' + esc(monthDay(p.day)) + '</text>';
        }
      });

      el.innerHTML =
        '<div class="chart-tip" id="chartTip" aria-hidden="true"></div>' +
        '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily baseline and injected token trend">' +
        grid + bars + labels + '</svg>' +
        '<div class="chart-legend" aria-hidden="true"><span class="lg"><span class="lg-sq" style="background:#d4a017"></span>Baseline</span><span class="lg"><span class="lg-sq" style="background:#00d4a4"></span>Injected</span></div>';

      var tip = qs("chartTip");
      function show(i, evt) {
        var p = points[i];
        var rect = el.getBoundingClientRect();
        var lx = evt && typeof evt.clientX === "number" ? evt.clientX - rect.left : rect.width / 2;
        tip.style.left = Math.min(rect.width - 100, Math.max(100, lx)) + "px";
        tip.style.top = "20px";
        tip.innerHTML = '<strong>' + esc(p.day) + '</strong>' +
          '<div class="tip-row"><span>Runs</span><span>' + fmt.format(p.runs) + '</span></div>' +
          '<div class="tip-row"><span>Baseline</span><span style="color:#d4a017">' + fmt.format(p.baselineTokens) + '</span></div>' +
          '<div class="tip-row"><span>Injected</span><span style="color:#00d4a4">' + fmt.format(p.injectedTokens) + '</span></div>' +
          '<div class="tip-row"><span>Saved</span><span style="color:#3dd68c">' + fmt.format(p.savedTokens) + '  ' + pct.format(p.savingsRatio || 0) + '</span></div>';
        tip.classList.add("is-on");
      }
      function hide() { tip.classList.remove("is-on"); }
      var hits = el.querySelectorAll(".hit");
      for (var k = 0; k < hits.length; k++) {
        (function (hit) {
          var i = Number(hit.getAttribute("data-i"));
          hit.addEventListener("mouseenter", function (e) { show(i, e); });
          hit.addEventListener("mousemove", function (e) { show(i, e); });
          hit.addEventListener("mouseleave", hide);
          hit.addEventListener("focus", function (e) { show(i, e); });
          hit.addEventListener("blur", hide);
        })(hits[k]);
      }
    }

    function renderScopes(scopes) {
      var total = SCOPE_ORDER.reduce(function (a, n) { return a + (scopes[n] || 0); }, 0);
      qs("scopeMeta").textContent = fmt.format(total) + " records";
      qs("scopeBars").innerHTML = SCOPE_ORDER.map(function (name) {
        var v = scopes[name] || 0;
        var w = total ? Math.max(v ? 2 : 0, Math.round((v / total) * 100)) : 0;
        return '<div class="scope-row"><span class="scope-name">' + esc(name) + '</span>' +
          '<div class="bar"><span class="bar-fill--' + esc(name) + '" style="width:' + w + '%"></span></div>' +
          '<span class="scope-count">' + fmt.format(v) + '</span></div>';
      }).join("");
    }

    function renderPaths(paths) {
      qs("paths").innerHTML = [["Store", paths.storePath], ["Meter", paths.meterLogPath], ["Control", paths.controlPath]]
        .map(function (r) {
          return '<div class="path-row"><div class="path-label">' + esc(r[0]) + '</div><div class="path-value">' + esc(r[1]) + '</div></div>';
        }).join("");
    }

    function renderAgentTable(agents) {
      qs("agentCount").textContent = agents.length + " agents";
      var maxSaved = Math.max.apply(null, agents.map(function (a) { return a.savedTokens; }).concat([0]));
      var rows = agents.slice(0, 40).map(function (a) {
        var ratio = a.savingsRatio || 0;
        var w = maxSaved ? Math.max(2, Math.round((a.savedTokens / maxSaved) * 100)) : 0;
        return '<tr>' +
          '<td><code>' + esc(a.agentId) + '</code></td>' +
          '<td class="num">' + fmt.format(a.runs) + '</td>' +
          '<td class="num c-base">' + fmt.format(a.baselineTokens) + '</td>' +
          '<td class="num c-inj">' + fmt.format(a.injectedTokens) + '</td>' +
          '<td class="num c-saved">' + fmt.format(a.savedTokens) + '</td>' +
          '<td class="num c-pct">' + pct.format(ratio) + '</td>' +
          '<td class="share-cell"><div class="bar"><span style="width:' + w + '%"></span></div></td>' +
          '</tr>';
      }).join("");
      qs("agentRows").innerHTML = rows || '<tr><td colspan="7" class="table-empty">No agent receipts yet.</td></tr>';
    }

    function renderEvents(events) {
      qs("events").innerHTML = events.map(function (e) {
        var ratio = e.baselineTokens ? (e.baselineTokens - e.injectedTokens) / e.baselineTokens : 0;
        return '<div class="event"><div class="event-main">' +
          '<code class="event-agent">' + esc(e.agentId) + '</code>' +
          '<time class="event-time" datetime="' + new Date(e.at).toISOString() + '">' + esc(relTime(e.at)) + '</time>' +
          '</div><span class="pill">+' + fmt.format(e.savedTokens) + ' saved (' + pct.format(ratio) + ')</span></div>';
      }).join("") || '<div class="empty-box"><div>No receipts yet.</div></div>';
    }

    /* ── memories page ────────────────────────────────────────── */
    function uniqueTags(mems) {
      var set = {};
      mems.forEach(function (m) { (m.tags || []).forEach(function (t) { set[t] = true; }); });
      return Object.keys(set).sort();
    }
    function populateTagSelect(mems) {
      var sel = qs("memTag");
      var cur = sel.value;
      var tags = uniqueTags(mems);
      sel.innerHTML = '<option value="">All tags</option>' + tags.map(function (t) {
        return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
      }).join("");
      sel.value = cur;
    }
    function filteredMemories() {
      var mems = (state.data && state.data.memories) || [];
      var q = state.memSearch.toLowerCase();
      return mems.filter(function (m) {
        if (state.memScope !== "all" && m.scope !== state.memScope) return false;
        if (state.memTag && (m.tags || []).indexOf(state.memTag) === -1) return false;
        if (q) {
          var hay = (m.text + " " + (m.agentId || "") + " " + (m.tags || []).join(" ")).toLowerCase();
          if (hay.indexOf(q) === -1) return false;
        }
        return true;
      });
    }
    function renderMemories() {
      var all = filteredMemories();
      qs("memCount").textContent = fmt.format(all.length);
      var shown = all.slice(0, state.memLimit);
      if (!shown.length) {
        qs("memRows").innerHTML = '<tr><td colspan="7"><div class="empty-box"><div class="ascii">' +
          esc("+--------------+\n|   NO DATA    |\n+--------------+") +
          '</div><div>No memories stored yet.</div><div class="hint">Run: <code>remember(agentId, text, tags)</code><br>Or: <code>npm run import:memories</code></div></div></td></tr>';
        qs("memLoadMore").hidden = true;
        return;
      }
      qs("memRows").innerHTML = shown.map(function (m) {
        var badge = "badge--" + (["org", "agent", "session"].indexOf(m.scope) >= 0 ? m.scope : "unknown");
        var tags = (m.tags || []).slice(0, 3).map(function (t) { return '<span class="tagp">' + esc(t) + '</span>'; }).join("");
        if ((m.tags || []).length > 3) tags += '<span class="tagp">+' + ((m.tags.length) - 3) + '</span>';
        var pinIco = m.pinned ? '<span class="status-ico on-pin" title="Pinned">★</span>' : '<span class="status-ico off">☆</span>';
        var disIco = m.disabled ? '<span class="status-ico on-dis" title="Disabled">⊘</span>' : '<span class="status-ico off">◌</span>';
        return '<tr data-id="' + esc(m.id) + '">' +
          '<td><span class="badge ' + badge + '">' + esc(m.scope) + '</span></td>' +
          '<td>' + (m.agentId ? esc(m.agentId) : '<span style="color:var(--faint)">--</span>') + '</td>' +
          '<td class="mem-text-cell"><div class="mem-text" data-action="expand" title="Click to expand">' + esc(m.text) + '</div></td>' +
          '<td class="num">' + fmt.format(m.tokens) + '</td>' +
          '<td>' + (tags || '<span style="color:var(--faint)">--</span>') + '</td>' +
          '<td style="text-align:center">' + pinIco + ' ' + disIco + '</td>' +
          '<td style="text-align:right"><div class="row-actions">' +
            '<button class="ico-btn ' + (m.pinned ? "is-on-pin" : "") + '" data-action="pin" title="' + (m.pinned ? "Unpin" : "Pin") + '">' + (m.pinned ? "⊖" : "⊕") + '</button>' +
            '<button class="ico-btn ' + (m.disabled ? "is-on-dis" : "") + '" data-action="disable" title="' + (m.disabled ? "Enable" : "Disable") + '">' + (m.disabled ? "◉" : "⊘") + '</button>' +
            '<button class="ico-btn btn-prune" data-action="prune" title="Prune">×</button>' +
          '</div></td></tr>';
      }).join("");
      qs("memLoadMore").hidden = all.length <= state.memLimit;
    }

    function patchMemory(id, fields) {
      var mems = (state.data && state.data.memories) || [];
      for (var i = 0; i < mems.length; i++) {
        if (mems[i].id === id) { for (var k in fields) mems[i][k] = fields[k]; return; }
      }
    }
    function removeMemoryLocal(id) {
      if (!state.data) return;
      state.data.memories = state.data.memories.filter(function (m) { return m.id !== id; });
    }

    qs("memRows").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-action]");
      if (!btn) return;
      var action = btn.getAttribute("data-action");
      var tr = btn.closest("tr");
      if (!tr) return;
      var id = tr.getAttribute("data-id");

      if (action === "expand") {
        var existing = tr.nextElementSibling;
        if (existing && existing.classList.contains("expand-row")) { existing.parentNode.removeChild(existing); return; }
        var mem = (state.data.memories || []).filter(function (m) { return m.id === id; })[0];
        if (!mem) return;
        var row = document.createElement("tr");
        row.className = "expand-row";
        row.innerHTML = '<td colspan="7"><div class="mem-expand">' + esc(mem.text) + '</div></td>';
        tr.parentNode.insertBefore(row, tr.nextElementSibling);
        return;
      }
      if (action === "pin") {
        api("POST", "/api/memory/" + encodeURIComponent(id) + "/pin").then(function (r) {
          patchMemory(id, { pinned: !!r.pinned }); renderMemories();
        });
        return;
      }
      if (action === "disable") {
        api("POST", "/api/memory/" + encodeURIComponent(id) + "/disable").then(function (r) {
          patchMemory(id, { disabled: !!r.disabled }); renderMemories();
        });
        return;
      }
      if (action === "prune") {
        var cell = btn.closest("td");
        var box = document.createElement("span");
        box.className = "confirm-inline";
        box.innerHTML = 'Delete? <button class="yes" data-c="yes">Yes</button><button data-c="no">No</button>';
        var prev = cell.querySelector(".row-actions");
        if (prev) prev.style.display = "none";
        cell.appendChild(box);
        box.addEventListener("click", function (ev) {
          var c = ev.target.getAttribute("data-c");
          if (c === "yes") {
            api("DELETE", "/api/memory/" + encodeURIComponent(id), { confirm: true }).then(function () {
              removeMemoryLocal(id); renderMemories();
            });
          } else if (c === "no") {
            box.parentNode.removeChild(box);
            if (prev) prev.style.display = "";
          }
        });
        return;
      }
    });

    qs("memSearch").addEventListener("input", function (e) { state.memSearch = e.target.value; state.memLimit = 100; renderMemories(); });
    qs("memTag").addEventListener("change", function (e) { state.memTag = e.target.value; state.memLimit = 100; renderMemories(); });
    qs("memScopeTabs").addEventListener("click", function (e) {
      var tab = e.target.closest(".scope-tab");
      if (!tab) return;
      var tabs = qs("memScopeTabs").querySelectorAll(".scope-tab");
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("is-active");
      tab.classList.add("is-active");
      state.memScope = tab.getAttribute("data-scope");
      state.memLimit = 100;
      renderMemories();
    });
    qs("memLoadMore").addEventListener("click", function () { state.memLimit += 100; renderMemories(); });

    /* ── agents page ──────────────────────────────────────────── */
    function renderKill(on) {
      var card = qs("killCard");
      card.classList.toggle("is-on", on);
      qs("killTitle").textContent = on ? "⚠ KILL-SWITCH ACTIVE" : "GLOBAL KILL-SWITCH";
      qs("killDesc").textContent = on
        ? "All recall operations are DISABLED. Agents are loading full context (expensive)."
        : "Disables all recall operations fleet-wide. Agents fall back to loading full context.";
      qs("killState").textContent = on ? "ON" : "OFF";
      var tog = qs("killToggle");
      tog.setAttribute("aria-checked", on ? "true" : "false");
    }
    function renderAgentCards(agents) {
      qs("agCount").textContent = "(" + agents.length + ")";
      qs("agentCount");
      qs("agentCards").innerHTML = agents.map(function (a) {
        var ratio = a.savingsRatio || 0;
        var w = Math.round(ratio * 100);
        var hasRuns = a.runs > 0;
        var budgetVal = a.budget == null ? "" : a.budget;
        return '<div class="agent-card ' + (a.disabled ? "is-muted" : "") + '" data-id="' + esc(a.agentId) + '">' +
          '<div class="ac-head"><div class="ac-id">' + esc(a.agentId) + (a.disabled ? ' <span class="muted-suffix">(muted)</span>' : '') + '</div>' +
          '<div class="ac-runs">' + (hasRuns ? fmt.format(a.runs) + " runs" : "no runs yet") + '</div></div>' +
          '<div class="ac-body">' +
            (hasRuns
              ? '<div class="ac-saved">Saved ' + pct.format(ratio) + '</div>' +
                '<div class="ac-tokens">' + compactTokens(a.baselineTokens) + ' / ' + compactTokens(a.injectedTokens) + ' tokens</div>' +
                '<div class="bar"><span style="width:' + w + '%"></span></div>'
              : '<div class="ac-saved is-zero">No runs yet</div>') +
          '</div>' +
          '<div class="ac-foot">' +
            '<div class="ac-ctl"><span>Budget</span><input class="budget-input" type="number" min="100" step="100" placeholder="none" value="' + esc(budgetVal) + '" data-budget aria-label="Token budget for ' + esc(a.agentId) + '"></div>' +
            '<div class="ac-ctl"><span>Mute</span><button class="toggle toggle--sm" role="switch" aria-checked="' + (a.disabled ? "true" : "false") + '" aria-label="Mute agent ' + esc(a.agentId) + '" data-mute tabindex="0"><span class="knob"></span></button></div>' +
          '</div></div>';
      }).join("") || '<div class="empty-box" style="grid-column:1/-1"><div>No agents configured yet.</div><div class="hint">Agents appear here after their first <code>recall()</code> or once a budget is set.</div></div>';
    }

    qs("killToggle").addEventListener("click", function () {
      var next = qs("killToggle").getAttribute("aria-checked") !== "true";
      if (next && !window.confirm("Enable the global kill-switch? This disables ALL recall operations fleet-wide.")) return;
      api("POST", "/api/killswitch", next ? { on: true, confirm: true } : { on: false }).then(function (r) {
        var on = !!r.killSwitch;
        renderKill(on);
        if (state.data) state.data.summary.killSwitch = on;
        qs("killBanner").hidden = !on;
        var note = qs("mMemNote");
        if (on) { note.textContent = "KILL-SWITCH ON"; note.className = "m-note is-kill"; }
        else { note.textContent = "kill-switch OFF"; note.className = "m-note is-ok"; }
      });
    });
    qs("killToggle").addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); qs("killToggle").click(); }
    });

    qs("agentCards").addEventListener("click", function (e) {
      var tog = e.target.closest("[data-mute]");
      if (!tog) return;
      var card = tog.closest(".agent-card");
      var id = card.getAttribute("data-id");
      var next = tog.getAttribute("aria-checked") !== "true";
      api("POST", "/api/agent/" + encodeURIComponent(id) + "/mute", { disabled: next }).then(function (r) {
        var on = !!r.disabled;
        tog.setAttribute("aria-checked", on ? "true" : "false");
        card.classList.toggle("is-muted", on);
        var idEl = card.querySelector(".ac-id");
        var base = id;
        idEl.innerHTML = esc(base) + (on ? ' <span class="muted-suffix">(muted)</span>' : '');
        var ag = (state.data.agents || []).filter(function (x) { return x.agentId === id; })[0];
        if (ag) ag.disabled = on;
      });
    });
    qs("agentCards").addEventListener("keydown", function (e) {
      var tog = e.target.closest("[data-mute]");
      if (tog && (e.key === " " || e.key === "Enter")) { e.preventDefault(); tog.click(); }
    });
    function commitBudget(input) {
      var card = input.closest(".agent-card");
      var id = card.getAttribute("data-id");
      var raw = input.value.trim();
      var body = raw === "" ? { budget: null } : { budget: Number(raw) };
      api("POST", "/api/agent/" + encodeURIComponent(id) + "/budget", body).then(function (r) {
        if (typeof r.budget === "number") input.value = r.budget;
        var ag = (state.data.agents || []).filter(function (x) { return x.agentId === id; })[0];
        if (ag) ag.budget = (r.budget == null ? null : r.budget);
      });
    }
    qs("agentCards").addEventListener("change", function (e) {
      var input = e.target.closest("[data-budget]");
      if (input) commitBudget(input);
    });
    qs("agentCards").addEventListener("keydown", function (e) {
      var input = e.target.closest("[data-budget]");
      if (input && e.key === "Enter") { e.preventDefault(); input.blur(); }
    });

    /* ── status + fetch ───────────────────────────────────────── */
    function setStatus(text, mode) {
      qs("statusText").textContent = text;
      qs("statusLine").classList.toggle("is-error", mode === "error");
      var dot = qs("statusDot");
      dot.className = "status-dot" + (mode === "live" ? " is-live" : mode === "error" ? " is-error" : "");
    }

    function api(method, path, body) {
      return fetch(path, {
        method: method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store"
      }).then(function (res) {
        if (!res.ok) throw new Error(method + " " + path + " → " + res.status);
        return res.json();
      });
    }

    function renderAll(data) {
      state.data = data;
      qs("errorBanner").hidden = true;
      qs("storePathFoot").textContent = (data.paths && data.paths.storePath) || "~/.thrift/";
      var s = data.summary;
      qs("killBanner").hidden = !s.killSwitch;
      renderMetrics(s);
      renderChart(data.trend);
      renderScopes(data.memoryScopes);
      renderPaths(data.paths);
      renderAgentTable(data.agents);
      renderEvents(data.recentEvents);
      // memories page
      state.memLimit = 100;
      populateTagSelect(data.memories || []);
      renderMemories();
      // agents page
      renderKill(s.killSwitch);
      renderAgentCards(data.agents);
      setStatus("Updated " + new Date(data.generatedAt).toLocaleTimeString(), "live");
    }

    function loadDashboard() {
      return api("GET", "/api/dashboard").then(renderAll);
    }
    function showError(msg) {
      clearSkeletons();
      var b = qs("errorBanner");
      b.textContent = "Error — could not reach /api/dashboard (" + msg + ")" + (state.data ? " · showing last known data" : "");
      b.hidden = false;
      setStatus("Error", "error");
    }

    qs("refreshBtn").addEventListener("click", function () {
      setStatus("Refreshing…", "");
      loadDashboard().catch(function (err) { showError(err.message); });
    });

    renderView();
    loadDashboard().catch(function (err) { showError(err.message); });
  })();
  </script>
</body>
</html>`;
