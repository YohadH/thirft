/**
 * Control panel CLI (M3).
 *
 * The owner-facing surface over {@link ControlPanel}. A CLI — not an HTTP server —
 * is the lightweight, serverless-safe choice the M3 task allows ("dashboard OR
 * CLI"): no port to manage, no web framework dependency, no long-lived process,
 * and every command is a pure function of (panel, argv, now) so it is trivially
 * testable.
 *
 * Commands:
 *   memories [--scope=S] [--agent=A]   table of stored memories (scope/agent/tags/tokens/pinned)
 *   agents [--since=MS]                per-agent token-savings rollup + controls
 *   summary [--since=MS]               fleet-wide savings card + kill-switch state
 *   pin <id> | unpin <id>             prioritize / de-prioritize a memory
 *   disable <id> | enable <id>        per-memory kill-switch
 *   prune <id>                        permanently delete a memory
 *   budget <agentId> <n|clear>        per-agent token-budget override
 *   mute <agentId> | unmute <agentId> per-agent kill-switch
 *   kill on|off                       global kill-switch
 *
 * All mutating commands persist (memories -> the JSONL store, controls -> the
 * settings JSON), so a change made here is honored by the next live recall.
 */

import type { ControlPanel } from "./panel.js";
import type { Scope } from "../types.js";

export interface CliResult {
  /** Lines to print to stdout. */
  out: string[];
  /** Process exit code (0 ok, 1 usage / not-found error). */
  code: number;
}

/** Parse `--name=value` flags out of an argv slice; returns positionals + flags. */
function parseArgs(argv: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) flags[a.slice(2)] = "true";
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const SCOPES: ReadonlySet<string> = new Set<Scope>(["org", "agent", "session"]);

function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

function renderString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function renderNumber(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

const USAGE = [
  "thrift-panel — owner control plane over Thrift memory",
  "",
  "Usage: thrift-panel <command> [args]",
  "",
  "  memories [--scope=S] [--agent=A]   list stored memories",
  "  agents   [--since=MS]              per-agent token-savings rollup",
  "  summary  [--since=MS]              fleet-wide savings + kill-switch",
  "  serve    [--host=H] [--port=N]      local browser dashboard",
  "  pin <id> | unpin <id>              prioritize / de-prioritize a memory",
  "  disable <id> | enable <id>         per-memory kill-switch",
  "  prune <id>                         permanently delete a memory",
  "  budget <agentId> <n|clear>         per-agent token-budget cap",
  "  mute <agentId> | unmute <agentId>  per-agent kill-switch",
  "  kill on|off                        global kill-switch",
];

/**
 * Run one CLI invocation against a panel. Pure: returns the output lines and an
 * exit code instead of touching stdout/process, so tests can assert on it.
 * `now` is injected (Thrift never reads the wall clock itself).
 */
export function runCli(panel: ControlPanel, argv: readonly string[], now: number): CliResult {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { out: USAGE, code: command === undefined ? 1 : 0 };

    case "memories": {
      const scope = flags["scope"];
      if (scope !== undefined && !SCOPES.has(scope)) {
        return { out: [`unknown scope: ${scope} (want org|agent|session)`], code: 1 };
      }
      const rows = panel.listMemories({
        ...(scope ? { scope: scope as Scope } : {}),
        ...(flags["agent"] ? { agentId: flags["agent"] } : {}),
      });
      if (rows.length === 0) return { out: ["(no memories)"], code: 0 };
      const out = [
        `${"id".padEnd(8)}  ${"scope".padEnd(7)}  ${"agent".padEnd(12)}  ${"tok".padStart(5)}  pin dis  tags / text`,
      ];
      for (const r of rows) {
        const id = renderString(r.id, "unknown");
        const scopeLabel = renderString(r.scope, "unknown");
        const tags = Array.isArray(r.tags) ? r.tags : [];
        const text = renderString(r.text, "");
        out.push(
          [
            id.slice(0, 8).padEnd(8),
            scopeLabel.slice(0, 7).padEnd(7),
            (r.agentId ?? "—").slice(0, 12).padEnd(12),
            renderNumber(r.tokens, "?").padStart(5),
            r.pinned ? " ● " : "   ",
            r.disabled ? " ✕ " : "   ",
            (tags.length ? `[${tags.join(",")}] ` : "") + truncate(text, 48),
          ].join("  "),
        );
      }
      out.push("", `${rows.length} memor${rows.length === 1 ? "y" : "ies"}`);
      return { out, code: 0 };
    }

    case "agents": {
      const since = flags["since"] ? Number(flags["since"]) : undefined;
      const views = panel.agentViews(since);
      if (views.length === 0) return { out: ["(no agents)"], code: 0 };
      const out = [
        `${"agent".padEnd(14)}  ${"runs".padStart(5)}  ${"baseline".padStart(9)}  ${"injected".padStart(9)}  ${"saved".padStart(9)}  ${"save%".padStart(6)}  ${"budget".padStart(7)}  mute  mem`,
      ];
      for (const v of views) {
        out.push(
          [
            v.agentId.slice(0, 14).padEnd(14),
            String(v.runs).padStart(5),
            String(v.baselineTokens).padStart(9),
            String(v.injectedTokens).padStart(9),
            String(v.savedTokens).padStart(9),
            fmtPct(v.savingsRatio).padStart(6),
            (v.budget === null ? "—" : String(v.budget)).padStart(7),
            (v.disabled ? "✕" : " ").padStart(4),
            String(v.memoryCount).padStart(3),
          ].join("  "),
        );
      }
      return { out, code: 0 };
    }

    case "summary": {
      const since = flags["since"] ? Number(flags["since"]) : undefined;
      const s = panel.fleetSummary(since);
      return {
        out: [
          "Fleet summary",
          `  kill-switch : ${s.killSwitch ? "ON (no injection fleet-wide)" : "off"}`,
          `  agents      : ${s.agents}`,
          `  runs        : ${s.runs}`,
          `  memories    : ${s.memoryCount}`,
          `  baseline    : ${s.baselineTokens} tok`,
          `  injected    : ${s.injectedTokens} tok`,
          `  saved       : ${s.savedTokens} tok (${fmtPct(s.savingsRatio)})`,
        ],
        code: 0,
      };
    }

    case "pin":
    case "unpin":
    case "disable":
    case "enable": {
      const id = positional[0];
      if (!id) return { out: [`usage: ${command} <id>`], code: 1 };
      const fn = { pin: panel.pin, unpin: panel.unpin, disable: panel.disable, enable: panel.enable }[command];
      const row = fn.call(panel, id, now);
      if (!row) return { out: [`no memory with id ${id}`], code: 1 };
      return { out: [`${command} ${row.id}  (pinned=${row.pinned} disabled=${row.disabled})`], code: 0 };
    }

    case "prune": {
      const id = positional[0];
      if (!id) return { out: ["usage: prune <id>"], code: 1 };
      const removed = panel.prune(id);
      return removed
        ? { out: [`pruned ${id}`], code: 0 }
        : { out: [`no memory with id ${id}`], code: 1 };
    }

    case "budget": {
      const [agentId, value] = positional;
      if (!agentId || value === undefined) return { out: ["usage: budget <agentId> <n|clear>"], code: 1 };
      if (value === "clear") {
        panel.setAgentBudget(agentId, undefined);
        return { out: [`cleared budget for ${agentId}`], code: 0 };
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return { out: [`budget must be a non-negative number, got ${value}`], code: 1 };
      panel.setAgentBudget(agentId, n);
      return { out: [`set budget for ${agentId} = ${Math.floor(n)} tok`], code: 0 };
    }

    case "mute":
    case "unmute": {
      const agentId = positional[0];
      if (!agentId) return { out: [`usage: ${command} <agentId>`], code: 1 };
      panel.setAgentDisabled(agentId, command === "mute");
      return { out: [`${command}d ${agentId}`], code: 0 };
    }

    case "kill": {
      const v = positional[0];
      if (v !== "on" && v !== "off") return { out: ["usage: kill on|off"], code: 1 };
      panel.setKillSwitch(v === "on");
      return { out: [`global kill-switch ${v === "on" ? "ENGAGED" : "released"}`], code: 0 };
    }

    default:
      return { out: [`unknown command: ${command}`, "", ...USAGE], code: 1 };
  }
}
