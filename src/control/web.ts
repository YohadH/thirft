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
const MAX_MEMORIES = 200;
const MAX_EVENTS = 25;

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

function routeDashboardRequest(
  panel: ControlPanel,
  paths: DashboardPaths,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendHtml(res, dashboardHtml());
    return;
  }

  if (url.pathname === "/api/dashboard") {
    sendJson(res, 200, buildDashboardData(panel, paths, Date.now()));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thrift Savings Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap">
  <style>
    :root {
      color-scheme: dark;

      --bg:          #0d1117;
      --surface:     #161b22;
      --surface-2:   #1c2128;
      --surface-accent: #0d2236;
      --surface-hover: #1f2937;

      --line:        #30363d;
      --line-accent: #1f6feb;

      --ink:         #e6edf3;
      --muted:       #8b949e;
      --mono:        #79c0ff;

      --teal:        #14b8a6;
      --teal-dim:    #0d9488;
      --teal-bg:     rgba(20, 184, 166, 0.10);

      --amber:       #f59e0b;
      --amber-dim:   #d97706;
      --amber-bg:    rgba(245, 158, 11, 0.10);

      --green:       #3fb950;
      --red:         #f85149;
      --slate:       #6e7681;

      --shadow-sm:   0 1px 2px rgba(0, 0, 0, 0.4);
      --shadow-md:   0 4px 12px rgba(0, 0, 0, 0.5);
      --shadow-tooltip: 0 8px 24px rgba(0, 0, 0, 0.6);

      --font-sans:   "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono:   "JetBrains Mono", "Fira Code", ui-monospace, "Cascadia Code", monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }
    button { font: inherit; }
    code, .mono { font-family: var(--font-mono); }

    /* ---- Topbar ---- */
    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      height: 60px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 24px;
      background: var(--bg);
      border-bottom: 1px solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 11px; }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: var(--teal);
      color: #04201c;
      display: grid;
      place-items: center;
      font-weight: 800;
      font-size: 18px;
    }
    .brand-text strong { display: block; font-size: 15px; line-height: 1.1; }
    .brand-text span { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
    .topbar-actions { display: flex; align-items: center; gap: 14px; }
    .refresh-status { display: flex; align-items: center; gap: 8px; }
    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--slate);
      flex: none;
    }
    .pulse-dot--live { background: var(--green); animation: pulse 2s ease-in-out infinite; }
    .pulse-dot--error { background: var(--red); }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.4); opacity: 0.5; }
    }
    .status { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .status.is-error { color: var(--red); }
    .button {
      border: 1px solid var(--line);
      background: var(--surface);
      color: var(--ink);
      border-radius: 8px;
      min-height: 34px;
      padding: 0 14px;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
    }
    .button:hover { border-color: #4b545e; background: var(--surface-2); }
    .button:focus-visible { outline: 2px solid var(--line-accent); outline-offset: 1px; }

    /* ---- Banners ---- */
    .warn-banner, .error-banner {
      padding: 10px 24px;
      font-size: 13px;
      line-height: 1.4;
      border-bottom: 1px solid var(--line);
    }
    .warn-banner { background: var(--amber-bg); color: var(--amber); border-color: var(--amber-dim); }
    .error-banner { background: rgba(248, 81, 73, 0.10); color: var(--red); border-color: var(--red); }
    .warn-banner code, .error-banner code { background: rgba(0,0,0,0.25); border-color: transparent; color: inherit; }
    [hidden] { display: none !important; }

    /* ---- Content ---- */
    .content {
      width: min(100%, 1320px);
      margin: 0 auto;
      padding: 22px 24px 40px;
    }

    /* ---- Hero metrics ---- */
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .metric {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px 16px;
      min-height: 112px;
    }
    .metric .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .metric .value {
      font-size: 28px;
      font-weight: 750;
      line-height: 1.1;
      color: var(--ink);
      white-space: nowrap;
    }
    .metric .note { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.4; }
    .metric--hero { background: var(--surface-accent); border-color: var(--teal-dim); }
    .metric--hero .value { font-size: 48px; color: var(--teal); }
    .metric--status .value { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .status-pill {
      display: inline-flex; align-items: center;
      height: 24px; padding: 0 10px;
      border-radius: 999px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.04em;
    }
    .status-pill--active { background: rgba(63, 185, 80, 0.15); color: var(--green); border: 1px solid rgba(63, 185, 80, 0.3); }
    .status-pill--killed { background: rgba(248, 81, 73, 0.15); color: var(--red); border: 1px solid rgba(248, 81, 73, 0.3); }

    /* ---- Skeleton ---- */
    .skeleton {
      color: transparent !important;
      background: linear-gradient(90deg, var(--surface) 25%, var(--surface-hover) 50%, var(--surface) 75%);
      background-size: 200%;
      animation: shimmer 1.5s infinite;
      border-radius: 4px;
      display: inline-block;
      min-width: 84px;
    }
    @keyframes shimmer { 0% { background-position: 200%; } 100% { background-position: -200%; } }

    /* ---- Grid + panels ---- */
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(300px, 1fr);
      gap: 16px;
      align-items: start;
    }
    .grid + .grid { margin-top: 16px; }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    .panel-head {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .panel-title { font-weight: 700; font-size: 14px; }
    .panel-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .side-stack { display: grid; gap: 16px; }

    /* ---- Chart ---- */
    .chart { height: 240px; padding: 14px 16px 12px; position: relative; }
    .chart svg { width: 100%; height: 100%; display: block; }
    .chart-legend {
      position: absolute;
      top: 16px; right: 18px;
      display: grid;
      gap: 5px;
      font-size: 11px;
      color: var(--muted);
      background: rgba(13, 17, 23, 0.6);
      padding: 7px 9px;
      border: 1px solid var(--line);
      border-radius: 7px;
    }
    .chart-legend .lg { display: flex; align-items: center; gap: 6px; }
    .chart-legend .lg-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .chart-tooltip {
      position: absolute;
      z-index: 5;
      min-width: 190px;
      padding: 10px 11px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      box-shadow: var(--shadow-tooltip);
      color: var(--ink);
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, -8px);
      transition: opacity 120ms ease;
      font-size: 12px;
    }
    .chart-tooltip.is-visible { opacity: 1; }
    .chart-tooltip strong { display: block; font-size: 13px; margin-bottom: 7px; }
    .tip-row { display: flex; justify-content: space-between; gap: 18px; line-height: 1.55; color: var(--muted); }
    .tip-row span:last-child { color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 650; }
    .trend-hit:focus-visible { outline: none; }

    /* ---- Empty states ---- */
    .empty {
      color: var(--muted);
      padding: 22px 16px;
      font-size: 13px;
      text-align: center;
    }
    .empty-hint { display: block; color: var(--slate); font-size: 12px; margin-top: 6px; }
    .empty code { background: var(--surface-2); }

    /* ---- Scopes ---- */
    .scope-bars { padding: 14px 16px 16px; display: grid; gap: 12px; }
    .scope-row {
      display: grid;
      grid-template-columns: 80px 1fr 44px 36px;
      gap: 10px;
      align-items: center;
      font-size: 13px;
    }
    .scope-name { color: var(--ink); font-weight: 600; }
    .scope-count { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink); }
    .scope-pct { text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
    .bar { height: 8px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
    .bar > span { display: block; height: 100%; border-radius: inherit; background: var(--teal); }
    .bar-fill--org { background: var(--teal); }
    .bar-fill--agent { background: var(--amber); }
    .bar-fill--session { background: var(--slate); }
    .bar-fill--unknown { background: var(--muted); }

    /* ---- Data files ---- */
    .paths { padding: 14px 16px 16px; display: grid; gap: 12px; }
    .path-row { display: grid; gap: 5px; min-width: 0; }
    .path-label { color: var(--muted); font-size: 12px; }
    .path-value-wrap { display: flex; align-items: stretch; gap: 6px; min-width: 0; }
    .path-value {
      flex: 1; min-width: 0;
      color: var(--mono);
      background: var(--surface-2);
      border: 1px solid var(--line);
      padding: 6px 8px;
      border-radius: 6px;
      font-size: 12px;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .copy-btn {
      flex: none;
      width: 30px;
      border: 1px solid var(--line);
      background: var(--surface-2);
      color: var(--muted);
      border-radius: 6px;
      cursor: pointer;
      display: grid;
      place-items: center;
    }
    .copy-btn:hover { color: var(--ink); border-color: #4b545e; }
    .copy-btn:focus-visible { outline: 2px solid var(--line-accent); outline-offset: 1px; }
    .copy-btn.is-done { color: var(--green); border-color: var(--green); }

    /* ---- Table ---- */
    .table-wrap { overflow: auto; max-height: 470px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--surface-2);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    tbody tr:hover { background: var(--surface-hover); }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    td .mono { color: var(--mono); font-size: 12px; }
    tr.is-leader td .mono { font-weight: 700; }
    .save-hi { color: var(--teal); }
    .save-mid { color: var(--amber); }
    .save-lo { color: var(--muted); }
    .bar-cell { min-width: 132px; }
    .table-empty { text-align: center; color: var(--muted); padding: 22px 12px; }
    .table-empty-hint { display: block; color: var(--slate); font-size: 12px; margin-top: 6px; }

    /* ---- Receipts ---- */
    .events { padding: 6px 0; max-height: 470px; overflow: auto; }
    .event {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .event:last-child { border-bottom: 0; }
    .event-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .event-agent { color: var(--mono); font-size: 12px; }
    .event-time { color: var(--muted); font-size: 12px; }
    .pill {
      display: inline-flex; align-items: center;
      height: 22px;
      border-radius: 999px;
      padding: 0 9px;
      font-size: 12px; font-weight: 650;
      white-space: nowrap;
    }
    .pill--high { background: var(--teal-bg); color: var(--teal); }
    .pill--mid { background: var(--amber-bg); color: var(--amber); }
    .pill--low { background: var(--surface-2); color: var(--muted); }

    /* ---- Onboarding ---- */
    .onboarding {
      max-width: 560px;
      margin: 60px auto;
      text-align: center;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 36px 32px;
    }
    .onboarding h2 { margin: 0 0 10px; font-size: 20px; }
    .onboarding p { color: var(--muted); font-size: 14px; line-height: 1.5; margin: 8px 0; }
    .onboarding-steps { margin-top: 22px; text-align: left; }
    .onboarding pre {
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 14px;
      overflow: auto;
      font-size: 12px;
      color: var(--mono);
    }

    /* ---- Responsive ---- */
    @media (max-width: 1000px) {
      .grid { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .metric--hero { grid-column: span 3; }
      .metric--hero .value { font-size: 40px; }
    }
    @media (max-width: 768px) {
      .content { padding: 18px 14px 32px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric--hero { grid-column: span 2; }
    }
    @media (max-width: 480px) {
      .metrics { grid-template-columns: 1fr; }
      .metric--hero { grid-column: span 1; }
      .metric--hero .value { font-size: 36px; }
      th, td { padding: 9px 10px; }
      .topbar { padding: 0 14px; }
      .brand-text span { display: none; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="mark" aria-hidden="true">T</div>
      <div class="brand-text">
        <strong>Thrift</strong>
        <span>Savings Dashboard</span>
      </div>
    </div>
    <div class="topbar-actions">
      <div class="refresh-status">
        <span class="pulse-dot" id="pulseDot" aria-hidden="true"></span>
        <span class="status" id="status" aria-live="polite">Loading...</span>
      </div>
      <button class="button" id="refresh" type="button" aria-label="Refresh dashboard data">Refresh</button>
    </div>
  </header>

  <div class="warn-banner" id="warnBanner" role="alert" hidden>Kill-switch is ON — Thrift is not serving recalls. Run <code>thrift-panel kill --off</code> to re-enable.</div>
  <div class="error-banner" id="errorBanner" role="alert" hidden></div>

  <main class="content">
    <section class="onboarding" id="onboarding" hidden>
      <h2>Thrift is running — no data yet</h2>
      <p>Once an agent calls <code>recall</code>, token savings appear here automatically.</p>
      <div class="onboarding-steps">
        <p>Quick start:</p>
        <pre><code>npx thrift-memory --store-path=~/.thrift/memories.jsonl --meter-path=~/.thrift/meter.jsonl</code></pre>
      </div>
    </section>

    <div id="mainBody">
      <section class="metrics" aria-label="Fleet metrics">
        <div class="metric metric--hero">
          <div class="label">Savings Rate</div>
          <div class="value skeleton" id="savingsRate">--</div>
          <div class="note" id="savingsNote">Saved / baseline tokens</div>
        </div>
        <div class="metric">
          <div class="label">Saved Tokens</div>
          <div class="value skeleton" id="savedTokens">--</div>
          <div class="note" id="tokenDelta">Baseline minus injected</div>
        </div>
        <div class="metric">
          <div class="label">Metered Runs</div>
          <div class="value skeleton" id="runs">--</div>
          <div class="note" id="agents">Agents with receipts</div>
        </div>
        <div class="metric">
          <div class="label">Memories</div>
          <div class="value skeleton" id="memories">--</div>
          <div class="note" id="memoriesNote">org / agent / session</div>
        </div>
        <div class="metric metric--status">
          <div class="label">Status</div>
          <div class="value" id="statusPill"><span class="status-pill status-pill--active">--</span></div>
          <div class="note" id="statusNote">fleet memory state</div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Daily Token Flow</div>
            <div class="panel-meta">last 30 active days</div>
          </div>
          <div class="chart" id="trendChart"></div>
        </div>

        <div class="side-stack">
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Memory Scope Distribution</div>
              <div class="panel-meta" id="scopeMeta">stored records</div>
            </div>
            <div class="scope-bars" id="scopeBars"></div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Data Files</div>
              <div class="panel-meta">local files backing these numbers</div>
            </div>
            <div class="paths" id="paths"></div>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Agent Savings</div>
            <div class="panel-meta" id="agentCount">--</div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th class="num">Runs</th>
                  <th class="num">Baseline</th>
                  <th class="num">Injected</th>
                  <th class="num">Saved</th>
                  <th class="num">Save %</th>
                  <th class="bar-cell">Share</th>
                </tr>
              </thead>
              <tbody id="agentRows"></tbody>
            </table>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Recent Receipts</div>
            <div class="panel-meta">meter log</div>
          </div>
          <div class="events" id="events"></div>
        </div>
      </section>
    </div>
  </main>

  <script>
    const fmt = new Intl.NumberFormat();
    const pct = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

    const qs = (id) => document.getElementById(id);
    const safe = (value) => value == null || value === "" ? "-" : String(value);
    const esc = (value) => safe(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));

    const SCOPE_ORDER = ["org", "agent", "session", "unknown"];

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "unknown time";
      return new Date(ms).toLocaleString();
    }

    function relativeTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "unknown";
      const diff = Date.now() - ms;
      if (diff < 0) return "just now";
      if (diff < 60000) return "just now";
      if (diff < 3600000) return Math.floor(diff / 60000) + " min ago";
      if (diff < 86400000) return Math.floor(diff / 3600000) + " hr ago";
      return new Date(ms).toLocaleDateString();
    }

    function monthDay(day) {
      const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(day || "");
      if (!m) return day || "";
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return months[Number(m[2]) - 1] + " " + Number(m[3]);
    }

    function barWidth(value, max) {
      if (!max) return 0;
      return Math.max(2, Math.round((value / max) * 100));
    }

    function clearSkeletons() {
      for (const el of document.querySelectorAll(".skeleton")) el.classList.remove("skeleton");
    }

    function renderTrend(points) {
      const el = qs("trendChart");
      if (!points.length) {
        el.innerHTML =
          '<div class="empty">No recall events yet.' +
          '<span class="empty-hint">Run an agent with <code>thrift recall</code> to see token flow here.</span></div>';
        return;
      }
      const width = 760, height = 220;
      const padL = 36, padR = 18, padT = 24, padB = 28;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const max = Math.max(...points.map((p) => p.baselineTokens), 1);
      const step = points.length > 1 ? plotW / (points.length - 1) : 0;
      const x = (i) => points.length > 1 ? padL + i * step : padL + plotW / 2;
      const y = (v) => padT + plotH - (v / max) * plotH;

      const baseline = points.map((p, i) => x(i) + "," + y(p.baselineTokens)).join(" ");
      const injected = points.map((p, i) => x(i) + "," + y(p.injectedTokens)).join(" ");
      // Saved area = region between baseline (top) and injected (bottom).
      const areaPts = points.map((p, i) => x(i) + "," + y(p.baselineTokens)).join(" ") + " " +
        points.slice().reverse().map((p) => {
          const i = points.indexOf(p);
          return x(i) + "," + y(p.injectedTokens);
        }).join(" ");

      // Y grid + labels at 0/33/66/100% of max.
      const ticks = [0, 0.33, 0.66, 1];
      const grid = ticks.map((t) => {
        const gy = y(max * t);
        return '<line x1="' + padL + '" y1="' + gy + '" x2="' + (width - padR) + '" y2="' + gy + '" stroke="#30363d" stroke-width="1"></line>' +
          '<text x="' + (padL - 6) + '" y="' + (gy + 3) + '" text-anchor="end" font-size="10" fill="#8b949e">' + fmt.format(Math.round(max * t)) + '</text>';
      }).join("");

      // X labels (every 3rd if crowded).
      const lblEvery = points.length > 14 ? 3 : (points.length > 7 ? 2 : 1);
      const xLabels = points.map((p, i) => {
        if (i % lblEvery !== 0 && i !== points.length - 1) return "";
        return '<text x="' + x(i) + '" y="' + (height - 8) + '" text-anchor="middle" font-size="10" fill="#8b949e">' + esc(monthDay(p.day)) + '</text>';
      }).join("");

      const dots = points.map((p, i) =>
        '<circle cx="' + x(i) + '" cy="' + y(p.baselineTokens) + '" r="3" fill="#f59e0b"></circle>' +
        '<circle cx="' + x(i) + '" cy="' + y(p.injectedTokens) + '" r="3" fill="#14b8a6"></circle>',
      ).join("");

      const hitWidth = points.length > 1 ? Math.max(36, step) : plotW;
      const hitZones = points.map((p, i) => {
        const hx = Math.max(padL, x(i) - hitWidth / 2);
        const hw = Math.min(hitWidth, width - padR - hx);
        const label = p.day + ': baseline ' + fmt.format(p.baselineTokens) + ', injected ' + fmt.format(p.injectedTokens) + ', saved ' + fmt.format(p.savedTokens);
        return '<rect class="trend-hit" data-index="' + i + '" tabindex="0" role="button" aria-label="' + esc(label) + '" x="' + hx + '" y="' + padT + '" width="' + hw + '" height="' + plotH + '" fill="transparent" style="cursor:crosshair;pointer-events:all"><title>' + esc(label) + '</title></rect>';
      }).join("");

      el.innerHTML =
        '<div class="chart-tooltip" id="trendTooltip" aria-hidden="true"></div>' +
        '<div class="chart-legend" aria-hidden="true">' +
          '<span class="lg"><span class="lg-dot" style="background:#f59e0b"></span>Baseline (would-have-paid)</span>' +
          '<span class="lg"><span class="lg-dot" style="background:#14b8a6"></span>Injected (Thrift loaded)</span>' +
        '</div>' +
        '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Daily baseline and injected token trend">' +
          grid +
          '<polygon points="' + areaPts + '" fill="rgba(20, 184, 166, 0.12)" stroke="none"></polygon>' +
          '<polyline points="' + baseline + '" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linejoin="round"></polyline>' +
          '<polyline points="' + injected + '" fill="none" stroke="#14b8a6" stroke-width="2" stroke-linejoin="round"></polyline>' +
          dots +
          xLabels +
          hitZones +
        '</svg>';

      const tooltip = qs("trendTooltip");
      const showTooltip = (event, point, index) => {
        const rect = el.getBoundingClientRect();
        const eventX = typeof event.clientX === "number" ? event.clientX - rect.left : (x(index) / width) * rect.width;
        const eventY = typeof event.clientY === "number" ? event.clientY - rect.top : (y(point.baselineTokens) / height) * rect.height;
        const left = Math.min(rect.width - 110, Math.max(110, eventX));
        const top = Math.max(10, eventY - 16);
        tooltip.style.left = left + "px";
        tooltip.style.top = top + "px";
        tooltip.innerHTML =
          '<strong>' + esc(point.day) + '</strong>' +
          '<div class="tip-row"><span>Runs</span><span>' + fmt.format(point.runs) + '</span></div>' +
          '<div class="tip-row"><span>Baseline</span><span>' + fmt.format(point.baselineTokens) + '</span></div>' +
          '<div class="tip-row"><span>Injected</span><span>' + fmt.format(point.injectedTokens) + '</span></div>' +
          '<div class="tip-row"><span>Saved</span><span>' + fmt.format(point.savedTokens) + '</span></div>' +
          '<div class="tip-row"><span>Savings</span><span>' + pct.format(point.savingsRatio || 0) + '</span></div>';
        tooltip.classList.add("is-visible");
        tooltip.setAttribute("aria-hidden", "false");
      };
      const hideTooltip = () => {
        tooltip.classList.remove("is-visible");
        tooltip.setAttribute("aria-hidden", "true");
      };
      for (const hit of el.querySelectorAll(".trend-hit")) {
        const index = Number(hit.dataset.index);
        hit.addEventListener("mouseenter", (event) => showTooltip(event, points[index], index));
        hit.addEventListener("mousemove", (event) => showTooltip(event, points[index], index));
        hit.addEventListener("mouseleave", hideTooltip);
        hit.addEventListener("focus", (event) => showTooltip(event, points[index], index));
        hit.addEventListener("blur", hideTooltip);
      }
    }

    function renderScopes(scopes) {
      const total = SCOPE_ORDER.reduce((a, name) => a + (scopes[name] || 0), 0);
      qs("scopeMeta").textContent = fmt.format(total) + " stored records";
      qs("scopeBars").innerHTML = SCOPE_ORDER.map((name) => {
        const value = scopes[name] || 0;
        const share = total ? Math.round((value / total) * 100) : 0;
        return '<div class="scope-row">' +
          '<span class="scope-name">' + esc(name) + '</span>' +
          '<div class="bar"><span class="bar-fill--' + esc(name) + '" style="width:' + barWidth(value, total) + '%"></span></div>' +
          '<span class="scope-count">' + fmt.format(value) + '</span>' +
          '<span class="scope-pct">' + share + '%</span>' +
        '</div>';
      }).join("");
    }

    const COPY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const CHECK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    function renderPaths(paths) {
      qs("paths").innerHTML = [
        ["Store", paths.storePath],
        ["Meter", paths.meterLogPath],
        ["Control", paths.controlPath],
      ].map(([label, value]) =>
        '<div class="path-row">' +
          '<div class="path-label">' + esc(label) + '</div>' +
          '<div class="path-value-wrap">' +
            '<code class="path-value">' + esc(value) + '</code>' +
            '<button class="copy-btn" type="button" aria-label="Copy ' + esc(label) + ' path" data-copy="' + esc(value) + '">' + COPY_ICON + '</button>' +
          '</div>' +
        '</div>'
      ).join("");
    }

    function saveClass(ratio) {
      if (ratio >= 0.7) return "save-hi";
      if (ratio >= 0.4) return "save-mid";
      return "save-lo";
    }

    function renderAgents(agents) {
      qs("agentCount").textContent = agents.length + " agents";
      const maxSaved = Math.max(...agents.map((a) => a.savedTokens), 0);
      let leaderIdx = -1, leaderSaved = -Infinity;
      agents.forEach((a, i) => { if (a.savedTokens > leaderSaved) { leaderSaved = a.savedTokens; leaderIdx = i; } });
      qs("agentRows").innerHTML = agents.slice(0, 40).map((a, i) => {
        const ratio = a.savingsRatio || 0;
        return '<tr class="' + (i === leaderIdx ? "is-leader" : "") + '">' +
          '<td><code class="mono">' + esc(a.agentId) + '</code></td>' +
          '<td class="num">' + fmt.format(a.runs) + '</td>' +
          '<td class="num">' + fmt.format(a.baselineTokens) + '</td>' +
          '<td class="num">' + fmt.format(a.injectedTokens) + '</td>' +
          '<td class="num">' + fmt.format(a.savedTokens) + '</td>' +
          '<td class="num ' + saveClass(ratio) + '">' + pct.format(ratio) + '</td>' +
          '<td class="bar-cell"><div class="bar"><span style="width:' + barWidth(a.savedTokens, maxSaved) + '%"></span></div></td>' +
        '</tr>';
      }).join("") ||
        '<tr><td colspan="7" class="table-empty">No agent receipts yet.' +
        '<span class="table-empty-hint">Each <code>recall</code> call logs one receipt here.</span></td></tr>';
    }

    function pillClass(ratio) {
      if (ratio >= 0.7) return "pill--high";
      if (ratio >= 0.4) return "pill--mid";
      return "pill--low";
    }

    function renderEvents(events) {
      qs("events").innerHTML = events.map((e) => {
        const ratio = e.baselineTokens ? (e.baselineTokens - e.injectedTokens) / e.baselineTokens : 0;
        return '<div class="event">' +
          '<div class="event-main">' +
            '<code class="event-agent">' + esc(e.agentId) + '</code>' +
            '<time class="event-time" datetime="' + new Date(e.at).toISOString() + '" title="' + esc(formatTime(e.at)) + '">' + esc(relativeTime(e.at)) + '</time>' +
          '</div>' +
          '<span class="pill ' + pillClass(ratio) + '">' + fmt.format(e.savedTokens) + ' saved (' + pct.format(ratio) + ')</span>' +
        '</div>';
      }).join("") ||
        '<div class="empty">No receipts yet.<span class="empty-hint">Each <code>recall</code> call logs one receipt here.</span></div>';
    }

    function setStatus(text, mode) {
      const statusEl = qs("status");
      const dot = qs("pulseDot");
      statusEl.textContent = text;
      statusEl.classList.toggle("is-error", mode === "error");
      dot.className = "pulse-dot" + (mode === "live" ? " pulse-dot--live" : mode === "error" ? " pulse-dot--error" : "");
    }

    function renderStatusCard(killSwitch) {
      const pill = qs("statusPill");
      if (killSwitch) {
        pill.innerHTML = '<span class="status-pill status-pill--killed">KILL-SWITCH ON</span>';
        qs("statusNote").textContent = "memory disabled";
      } else {
        pill.innerHTML = '<span class="status-pill status-pill--active">ACTIVE</span>';
        qs("statusNote").textContent = "fleet memory active";
      }
      qs("warnBanner").hidden = !killSwitch;
    }

    async function loadDashboard() {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      if (!res.ok) throw new Error("Dashboard API failed: " + res.status);
      const data = await res.json();
      const s = data.summary;

      // First-run onboarding.
      const empty = s.runs === 0 && s.memoryCount === 0;
      qs("onboarding").hidden = !empty;
      qs("mainBody").hidden = empty;

      clearSkeletons();
      qs("errorBanner").hidden = true;

      qs("savingsRate").textContent = empty ? "0%" : pct.format(s.savingsRatio || 0);
      qs("savedTokens").textContent = fmt.format(s.savedTokens);
      qs("runs").textContent = fmt.format(s.runs);
      qs("memories").textContent = fmt.format(s.memoryCount);
      qs("savingsNote").textContent = empty
        ? "No recalls metered yet — run an agent"
        : fmt.format(s.savedTokens) + " saved of " + fmt.format(s.baselineTokens) + " baseline";
      qs("tokenDelta").textContent = fmt.format(s.baselineTokens) + " baseline / " + fmt.format(s.injectedTokens) + " injected";
      qs("agents").textContent = fmt.format(s.agents) + " agents with receipts";

      renderStatusCard(s.killSwitch);
      renderTrend(data.trend);
      renderScopes(data.memoryScopes);
      renderPaths(data.paths);
      renderAgents(data.agents);
      renderEvents(data.recentEvents);

      setStatus("Updated " + new Date(data.generatedAt).toLocaleTimeString(), "live");
    }

    function showError(message) {
      clearSkeletons();
      const banner = qs("errorBanner");
      banner.textContent = "Dashboard API failed: " + message + ". Retrying in 30s.";
      banner.hidden = false;
      setStatus(message, "error");
    }

    // Copy-to-clipboard (event delegation, no server call).
    qs("paths").addEventListener("click", (event) => {
      const btn = event.target.closest(".copy-btn");
      if (!btn) return;
      const text = btn.getAttribute("data-copy") || "";
      const done = () => {
        btn.classList.add("is-done");
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => { btn.classList.remove("is-done"); btn.innerHTML = COPY_ICON; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {});
      }
    });

    let pollTimer = null;
    function startPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        loadDashboard().catch((err) => showError(err.message));
      }, 30000);
    }

    function refresh() {
      loadDashboard().then(startPolling).catch((err) => { showError(err.message); startPolling(); });
    }

    qs("refresh").addEventListener("click", refresh);
    refresh();
  </script>
</body>
</html>`;
}
