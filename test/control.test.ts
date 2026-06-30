import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";
import { ControlSettings } from "../src/control/settings.js";
import { ControlPanel } from "../src/control/panel.js";
import { runCli } from "../src/control/cli.js";
import { readMeterLog, rollupEventsByAgent } from "../src/control/meterLog.js";
import { buildDashboardData, startDashboardServer } from "../src/control/web.js";
import type { DashboardServerHandle } from "../src/control/web.js";
import { ThriftMcpServer } from "../src/mcp/server.js";

const T0 = 1_000_000_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "thrift-control-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── ControlSettings ───────────────────────────────────────────────────────────

describe("ControlSettings", () => {
  it("effectiveBudget returns the requested budget by default", () => {
    const s = new ControlSettings();
    expect(s.effectiveBudget("dev", 2000)).toBe(2000);
  });

  // The JSDoc on effectiveBudget asserts "global kill-switch on -> 0" — tested.
  it("global kill-switch forces effective budget to 0 for every agent", () => {
    const s = new ControlSettings();
    s.setKillSwitch(true);
    expect(s.effectiveBudget("dev", 2000)).toBe(0);
    expect(s.effectiveBudget("qa", 9999)).toBe(0);
  });

  // JSDoc: "this agent disabled -> 0" — tested.
  it("a disabled agent gets 0 budget while others are unaffected", () => {
    const s = new ControlSettings();
    s.setAgentDisabled("dev", true);
    expect(s.effectiveBudget("dev", 2000)).toBe(0);
    expect(s.effectiveBudget("qa", 2000)).toBe(2000);
  });

  // JSDoc: "per-agent budget set -> min(requested, agentBudget) (the tighter wins)" — tested both directions.
  it("per-agent budget caps to the tighter of requested vs cap", () => {
    const s = new ControlSettings();
    s.setAgentBudget("dev", 500);
    expect(s.effectiveBudget("dev", 2000)).toBe(500); // cap tighter
    expect(s.effectiveBudget("dev", 200)).toBe(200); // request tighter
  });

  it("kill-switch takes precedence over a per-agent budget", () => {
    const s = new ControlSettings();
    s.setAgentBudget("dev", 500);
    s.setKillSwitch(true);
    expect(s.effectiveBudget("dev", 2000)).toBe(0);
  });

  it("rejects a negative agent budget", () => {
    const s = new ControlSettings();
    expect(() => s.setAgentBudget("dev", -1)).toThrow(/non-negative/);
  });

  it("persists to disk and reloads identical state", () => {
    const path = join(dir, "control.json");
    const a = new ControlSettings({ path });
    a.setKillSwitch(true);
    a.setAgentBudget("dev", 750);
    a.setAgentDisabled("qa", true);
    const b = new ControlSettings({ path });
    expect(b.isKilled()).toBe(true);
    expect(b.getAgentBudget("dev")).toBe(750);
    expect(b.isAgentDisabled("qa")).toBe(true);
    // file is valid JSON
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("a corrupt control file falls back to defaults rather than crashing", () => {
    const path = join(dir, "control.json");
    writeFileSync(path, "{ this is not json");
    const s = new ControlSettings({ path });
    expect(s.isKilled()).toBe(false);
    expect(s.snapshot().agentBudgets).toEqual({});
  });
});

// ── meter-log reader ───────────────────────────────────────────────────────────

describe("readMeterLog / rollupEventsByAgent", () => {
  it("returns [] for a missing file and skips malformed lines", () => {
    expect(readMeterLog(join(dir, "nope.jsonl"))).toEqual([]);
    const path = join(dir, "meter.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ at: T0, agentId: "dev", injectedTokens: 100, baselineTokens: 1000, savedTokens: 900 }),
        "{ broken",
        "",
        JSON.stringify({ at: T0 + 1, agentId: "dev", injectedTokens: 50, baselineTokens: 500 }),
      ].join("\n") + "\n",
    );
    const events = readMeterLog(path);
    expect(events).toHaveLength(2);
    // savedTokens is derived when absent
    expect(events[1].savedTokens).toBe(450);
  });

  it("rolls events up per agent with a correct savings ratio", () => {
    const events = [
      { at: T0, agentId: "dev", injectedTokens: 100, baselineTokens: 1000, savedTokens: 900 },
      { at: T0 + 1, agentId: "dev", injectedTokens: 100, baselineTokens: 1000, savedTokens: 900 },
      { at: T0 + 2, agentId: "qa", injectedTokens: 200, baselineTokens: 400, savedTokens: 200 },
    ];
    const rollups = rollupEventsByAgent(events);
    const dev = rollups.find((r) => r.agentId === "dev")!;
    expect(dev.runs).toBe(2);
    expect(dev.baselineTokens).toBe(2000);
    expect(dev.savedTokens).toBe(1800);
    expect(dev.savingsRatio).toBeCloseTo(0.9, 5);
  });

  it("honors the `since` window", () => {
    const events = [
      { at: T0, agentId: "dev", injectedTokens: 100, baselineTokens: 1000, savedTokens: 900 },
      { at: T0 + 10, agentId: "dev", injectedTokens: 100, baselineTokens: 1000, savedTokens: 900 },
    ];
    expect(rollupEventsByAgent(events, T0 + 5)[0].runs).toBe(1);
  });
});

// ── ControlPanel: memories view + acts ──────────────────────────────────────────

describe("ControlPanel memories", () => {
  function freshPanel() {
    const store = new JsonlStore({ path: join(dir, "memories.jsonl") });
    const settings = new ControlSettings({ path: join(dir, "control.json") });
    const panel = new ControlPanel({ store, settings, meterLogPath: join(dir, "meter.jsonl") });
    return { store, settings, panel };
  }

  it("lists memories pinned-first then newest", () => {
    const { store, panel } = freshPanel();
    store.add({ scope: "org", text: "old" }, T0);
    const newer = store.add({ scope: "org", text: "newer" }, T0 + 10);
    panel.pin(newer.id, T0 + 11);
    store.add({ scope: "org", text: "newest unpinned" }, T0 + 20);
    const rows = panel.listMemories();
    expect(rows[0].pinned).toBe(true); // pinned first regardless of recency
    expect(rows[0].id).toBe(newer.id);
  });

  it("pin/unpin/disable/enable round-trip and persist to the store file", () => {
    const { store, panel } = freshPanel();
    const m = store.add({ scope: "org", text: "knob me" }, T0);
    expect(panel.pin(m.id, T0 + 1)?.pinned).toBe(true);
    expect(panel.disable(m.id, T0 + 2)?.disabled).toBe(true);
    expect(panel.enable(m.id, T0 + 3)?.disabled).toBe(false);
    expect(panel.unpin(m.id, T0 + 4)?.pinned).toBe(false);

    // Reload the store from disk: the flags survived the write path.
    const reloaded = new JsonlStore({ path: join(dir, "memories.jsonl") });
    const back = reloaded.get(m.id)!;
    expect(back.pinned).toBe(false);
    expect(back.disabled).toBe(false);
    expect(back.updatedAt).toBe(T0 + 4);
  });

  // Destructive-persistence test: survival / gone / no-dupe / file-valid.
  it("prune permanently removes a memory and survives a reload (no resurrection)", () => {
    const memPath = join(dir, "memories.jsonl");
    const { store, panel } = freshPanel();
    const keep = store.add({ scope: "org", text: "keep me" }, T0);
    const kill = store.add({ scope: "org", text: "delete me" }, T0 + 1);

    expect(panel.prune(kill.id)).toBe(true);
    expect(panel.prune(kill.id)).toBe(false); // already gone — idempotent
    expect(panel.getMemory(kill.id)).toBeUndefined(); // gone in-memory

    // gone after reload (tombstone replayed), survivor intact, no duplicate of survivor
    const reloaded = new JsonlStore({ path: memPath });
    expect(reloaded.get(kill.id)).toBeUndefined();
    expect(reloaded.get(keep.id)?.text).toBe("keep me");
    expect(reloaded.list()).toHaveLength(1);

    // file is still valid JSONL (every non-empty line parses)
    for (const line of readFileSync(memPath, "utf8").split("\n")) {
      if (line.trim()) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("edit changes text and recomputes token cost", () => {
    const { store, panel } = freshPanel();
    const m = store.add({ scope: "org", text: "tiny" }, T0);
    const before = m.tokens;
    const row = panel.edit(m.id, { text: "a".repeat(400) }, T0 + 1);
    expect(row!.tokens).toBeGreaterThan(before);
  });
});

// ── ControlPanel: savings views from the real meter log ──────────────────────────

describe("ControlPanel savings views", () => {
  function panelWithMeter(lines: object[]) {
    const meterPath = join(dir, "meter.jsonl");
    writeFileSync(meterPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const store = new JsonlStore({ path: join(dir, "memories.jsonl") });
    const settings = new ControlSettings({ path: join(dir, "control.json") });
    return { store, settings, panel: new ControlPanel({ store, settings, meterLogPath: meterPath }) };
  }

  it("fleetSummary aggregates the full meter log honestly (baseline = full, not filtered)", () => {
    const { panel } = panelWithMeter([
      { at: T0, agentId: "dev", injectedTokens: 100, baselineTokens: 1000 },
      { at: T0 + 1, agentId: "qa", injectedTokens: 200, baselineTokens: 800 },
    ]);
    const s = panel.fleetSummary();
    expect(s.agents).toBe(2);
    expect(s.runs).toBe(2);
    expect(s.baselineTokens).toBe(1800); // full baseline, both agents
    expect(s.injectedTokens).toBe(300);
    expect(s.savedTokens).toBe(1500);
    expect(s.savingsRatio).toBeCloseTo(1500 / 1800, 5);
  });

  it("agentViews folds in agents that only have controls (no metered run yet)", () => {
    const { settings, panel } = panelWithMeter([
      { at: T0, agentId: "dev", injectedTokens: 100, baselineTokens: 1000 },
    ]);
    settings.setAgentBudget("planner", 500); // never metered
    const views = panel.agentViews();
    const ids = views.map((v) => v.agentId);
    expect(ids).toContain("dev");
    expect(ids).toContain("planner");
    const planner = views.find((v) => v.agentId === "planner")!;
    expect(planner.runs).toBe(0);
    expect(planner.budget).toBe(500);
  });
});

// ── Dashboard data ──────────────────────────────────────────────────────────────

describe("buildDashboardData", () => {
  it("builds savings, trend, recent receipts, and memory scope counts from local files", () => {
    const memPath = join(dir, "memories.jsonl");
    const meterPath = join(dir, "meter.jsonl");
    const controlPath = join(dir, "control.json");
    const store = new JsonlStore({ path: memPath });
    store.add({ scope: "org", text: "company memory" }, T0);
    store.add({ scope: "agent", agentId: "dev", text: "developer memory" }, T0 + 1);
    writeFileSync(
      meterPath,
      [
        JSON.stringify({ at: Date.UTC(2026, 5, 26), agentId: "dev", injectedTokens: 100, baselineTokens: 1000 }),
        JSON.stringify({ at: Date.UTC(2026, 5, 26) + 1, agentId: "qa", injectedTokens: 50, baselineTokens: 500 }),
        JSON.stringify({ at: Date.UTC(2026, 5, 27), agentId: "dev", injectedTokens: 80, baselineTokens: 400 }),
      ].join("\n") + "\n",
    );
    const settings = new ControlSettings({ path: controlPath });
    const panel = new ControlPanel({ store, settings, meterLogPath: meterPath });

    const data = buildDashboardData(panel, { storePath: memPath, meterLogPath: meterPath, controlPath }, T0 + 2);

    expect(data.generatedAt).toBe(T0 + 2);
    expect(data.summary.runs).toBe(3);
    expect(data.summary.baselineTokens).toBe(1900);
    expect(data.summary.injectedTokens).toBe(230);
    expect(data.summary.savedTokens).toBe(1670);
    expect(data.memoryScopes).toMatchObject({ org: 1, agent: 1, session: 0, unknown: 0 });
    expect(data.recentEvents).toHaveLength(3);
    expect(data.trend).toHaveLength(2);
    expect(data.trend[0]).toMatchObject({
      day: "2026-06-26",
      runs: 2,
      baselineTokens: 1500,
      injectedTokens: 150,
      savedTokens: 1350,
    });
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────

describe("runCli", () => {
  function freshPanel() {
    const store = new JsonlStore({ path: join(dir, "memories.jsonl") });
    const settings = new ControlSettings({ path: join(dir, "control.json") });
    const panel = new ControlPanel({ store, settings, meterLogPath: join(dir, "meter.jsonl") });
    return { store, settings, panel };
  }

  it("no command prints usage with a non-zero exit", () => {
    const { panel } = freshPanel();
    const r = runCli(panel, [], T0);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toMatch(/Usage:/);
  });

  it("kill on flips the global switch and persists", () => {
    const { panel, settings } = freshPanel();
    const r = runCli(panel, ["kill", "on"], T0);
    expect(r.code).toBe(0);
    expect(settings.isKilled()).toBe(true);
    const reloaded = new ControlSettings({ path: join(dir, "control.json") });
    expect(reloaded.isKilled()).toBe(true);
  });

  it("budget <agent> <n> sets a cap; clear removes it", () => {
    const { panel, settings } = freshPanel();
    expect(runCli(panel, ["budget", "dev", "500"], T0).code).toBe(0);
    expect(settings.getAgentBudget("dev")).toBe(500);
    expect(runCli(panel, ["budget", "dev", "clear"], T0).code).toBe(0);
    expect(settings.getAgentBudget("dev")).toBeUndefined();
  });

  it("budget rejects a non-numeric value with exit 1", () => {
    const { panel } = freshPanel();
    expect(runCli(panel, ["budget", "dev", "lots"], T0).code).toBe(1);
  });

  it("prune of a missing id exits 1; of a real id exits 0", () => {
    const { store, panel } = freshPanel();
    const m = store.add({ scope: "org", text: "x" }, T0);
    expect(runCli(panel, ["prune", "nope"], T0).code).toBe(1);
    expect(runCli(panel, ["prune", m.id], T0).code).toBe(0);
    expect(store.get(m.id)).toBeUndefined();
  });

  it("memories rejects an unknown scope", () => {
    const { panel } = freshPanel();
    expect(runCli(panel, ["memories", "--scope=bogus"], T0).code).toBe(1);
  });

  it("memories renders a row for a stored memory", () => {
    const { store, panel } = freshPanel();
    store.add({ scope: "agent", agentId: "dev", text: "remember the kill-switch", tags: ["m3"] }, T0);
    const r = runCli(panel, ["memories"], T0);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/dev/);
    expect(r.out.join("\n")).toMatch(/m3/);
  });

  it("memories tolerates a legacy row with a missing scope", () => {
    const memPath = join(dir, "memories.jsonl");
    writeFileSync(
      memPath,
      JSON.stringify({
        op: "put",
        record: {
          id: "legacy-no-scope",
          agentId: "dev",
          text: "legacy memory row",
          tags: ["legacy"],
          pinned: false,
          disabled: false,
          tokens: 5,
          createdAt: T0,
          updatedAt: T0,
        },
      }) + "\n",
    );
    const store = new JsonlStore({ path: memPath });
    const settings = new ControlSettings({ path: join(dir, "control.json") });
    const panel = new ControlPanel({ store, settings, meterLogPath: join(dir, "meter.jsonl") });

    const r = runCli(panel, ["memories"], T0);

    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/unknown/);
    expect(r.out.join("\n")).toMatch(/legacy memory row/);
  });

  it("an unknown command exits 1 and shows usage", () => {
    const { panel } = freshPanel();
    const r = runCli(panel, ["frobnicate"], T0);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toMatch(/unknown command/);
  });
});

// ── wiring: M3 controls bite at recall time (AP-T8 call-site / not just display) ──

describe("control wiring through ThriftMcpServer.resolveBudget", () => {
  it("kill-switch mutes injection but the savings receipt still shows the full avoided baseline", () => {
    const settings = new ControlSettings(); // in-memory control knobs
    const store = new JsonlStore();
    const srv = new ThriftMcpServer({
      store,
      retriever: new ScopedRetriever(),
      resolveBudget: (agentId, requested) => settings.effectiveBudget(agentId, requested),
    });
    srv.remember({ scope: "org", text: "company uses TypeScript across all services" }, T0);
    srv.remember({ scope: "agent", agentId: "dev", text: "dev agent specialises in TypeScript refactors" }, T0 + 1);

    // Controls off: agent gets context.
    const open = srv.recall({ agentId: "dev", task: "TypeScript refactor", tokenBudget: 10_000 }, T0 + 2);
    expect(open.injectedTokens).toBeGreaterThan(0);
    expect(open.baselineTokens).toBeGreaterThan(0);

    // Kill-switch on: zero injection, but baseline (the avoided cost) is still the full in-scope set.
    settings.setKillSwitch(true);
    const killed = srv.recall({ agentId: "dev", task: "TypeScript refactor", tokenBudget: 10_000 }, T0 + 3);
    expect(killed.injectedTokens).toBe(0);
    expect(killed.baselineTokens).toBe(open.baselineTokens);
    expect(killed.savedTokens).toBe(killed.baselineTokens);
  });

  it("a per-agent budget cap clamps injection without touching the baseline", () => {
    const settings = new ControlSettings();
    const srv = new ThriftMcpServer({
      store: new JsonlStore(),
      retriever: new ScopedRetriever(),
      resolveBudget: (agentId, requested) => settings.effectiveBudget(agentId, requested),
    });
    srv.remember({ scope: "org", text: "x".repeat(400) }, T0);
    srv.remember({ scope: "org", text: "y".repeat(400) }, T0 + 1);

    settings.setAgentBudget("dev", 20); // ~20 tokens — admits at most one ~100-token memory? none.
    const r = srv.recall({ agentId: "dev", task: "anything", tokenBudget: 10_000 }, T0 + 2);
    expect(r.injectedTokens).toBeLessThanOrEqual(20);
    expect(r.baselineTokens).toBeGreaterThan(20); // baseline = full in-scope set, un-clamped
  });
});

// ── Dashboard write endpoints (routeDashboardRequest) ─────────────────────────────
//
// DES-THRIFT-4 / DES-THRIFT-5: the Memories + Agents pages drive small POST/DELETE
// endpoints that must persist to the same JSONL store / control.json the live recall
// path reads. These tests start a real HTTP server and assert the side-effect survives
// a re-read from a fresh store/settings (round-trip), not just an in-memory toggle.

describe("dashboard write endpoints", () => {
  let handle: DashboardServerHandle;
  let memPath: string;
  let controlPath: string;
  let meterPath: string;

  async function freshServer() {
    memPath = join(dir, "memories.jsonl");
    controlPath = join(dir, "control.json");
    meterPath = join(dir, "meter.jsonl");
    const store = new JsonlStore({ path: memPath });
    const settings = new ControlSettings({ path: controlPath });
    const panel = new ControlPanel({ store, settings, meterLogPath: meterPath });
    handle = await startDashboardServer({
      panel,
      paths: { storePath: memPath, meterLogPath: meterPath, controlPath },
      host: "127.0.0.1",
      port: 0, // ephemeral port
    });
    return { store, settings, panel };
  }

  afterEach(async () => {
    if (handle) {
      await new Promise<void>((resolve) => handle.server.close(() => resolve()));
      handle = undefined as unknown as DashboardServerHandle;
    }
  });

  it("POST /api/memory/:id/pin toggles pin and persists to the store", async () => {
    const { store } = await freshServer();
    const m = store.add({ scope: "org", text: "pin me" }, T0);

    const on = await fetch(`${handle.url}/api/memory/${m.id}/pin`, { method: "POST" });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ ok: true, pinned: true });
    // round-trip: a fresh store replaying the same JSONL sees the pin.
    expect(new JsonlStore({ path: memPath }).get(m.id)?.pinned).toBe(true);

    const off = await fetch(`${handle.url}/api/memory/${m.id}/pin`, { method: "POST" });
    expect(await off.json()).toMatchObject({ ok: true, pinned: false });
    expect(new JsonlStore({ path: memPath }).get(m.id)?.pinned).toBe(false);
  });

  it("POST /api/memory/:id/disable toggles disabled and persists", async () => {
    const { store } = await freshServer();
    const m = store.add({ scope: "agent", agentId: "dev", text: "disable me" }, T0);

    const r = await fetch(`${handle.url}/api/memory/${m.id}/disable`, { method: "POST" });
    expect(await r.json()).toMatchObject({ ok: true, disabled: true });
    expect(new JsonlStore({ path: memPath }).get(m.id)?.disabled).toBe(true);
  });

  it("DELETE /api/memory/:id requires { confirm: true } and then prunes permanently", async () => {
    const { store } = await freshServer();
    const m = store.add({ scope: "org", text: "delete me" }, T0);

    const noConfirm = await fetch(`${handle.url}/api/memory/${m.id}`, { method: "DELETE" });
    expect(noConfirm.status).toBe(400);
    expect(await noConfirm.json()).toMatchObject({ error: "confirm_required" });
    expect(store.get(m.id)).toBeDefined(); // still there

    const confirmed = await fetch(`${handle.url}/api/memory/${m.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(await confirmed.json()).toMatchObject({ ok: true, pruned: m.id });
    expect(new JsonlStore({ path: memPath }).get(m.id)).toBeUndefined(); // gone after replay
  });

  it("404s a pin/disable/delete on an unknown memory id", async () => {
    await freshServer();
    expect((await fetch(`${handle.url}/api/memory/nope/pin`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${handle.url}/api/memory/nope/disable`, { method: "POST" })).status).toBe(404);
    const del = await fetch(`${handle.url}/api/memory/nope`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    expect(del.status).toBe(404);
  });

  it("POST /api/killswitch, /api/agent/:id/budget and /mute persist to control.json", async () => {
    await freshServer();

    // Turning the kill-switch ON requires { confirm: true } (mirrors DELETE).
    const noConfirm = await fetch(`${handle.url}/api/killswitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    expect(noConfirm.status).toBe(400);
    // Standardized: both confirm guards (kill-switch + memory-delete) return the
    // same underscore key so clients can pattern-match one error.
    expect(await noConfirm.json()).toMatchObject({ error: "confirm_required" });
    expect(new ControlSettings({ path: controlPath }).isKilled()).toBe(false); // not flipped

    expect(await (await fetch(`${handle.url}/api/killswitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: true, confirm: true }),
    })).json()).toMatchObject({ ok: true, killSwitch: true });
    expect(new ControlSettings({ path: controlPath }).isKilled()).toBe(true);

    // Turning it OFF is a recovery action — no confirmation required.
    expect(await (await fetch(`${handle.url}/api/killswitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: false }),
    })).json()).toMatchObject({ ok: true, killSwitch: false });
    expect(new ControlSettings({ path: controlPath }).isKilled()).toBe(false);

    expect(await (await fetch(`${handle.url}/api/agent/dev/budget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget: 500 }),
    })).json()).toMatchObject({ ok: true, budget: 500 });
    expect(new ControlSettings({ path: controlPath }).getAgentBudget("dev")).toBe(500);

    expect(await (await fetch(`${handle.url}/api/agent/dev/mute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    })).json()).toMatchObject({ ok: true, disabled: true });
    expect(new ControlSettings({ path: controlPath }).isAgentDisabled("dev")).toBe(true);
  });

  it("rejects an invalid budget and a GET to an unknown path", async () => {
    await freshServer();
    const bad = await fetch(`${handle.url}/api/agent/dev/budget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget: -5 }),
    });
    expect(bad.status).toBe(400);
    expect((await fetch(`${handle.url}/api/nope`)).status).toBe(404);
  });

  it("returns 400 (not 500) for a malformed percent-escape in the path segment", async () => {
    await freshServer();
    // A lone '%' / truncated escape makes decodeURIComponent throw URIError.
    // The handler must catch it and answer 400, never let it surface as a 500.
    // fetch() refuses to build such a URL, so hit the socket raw via node:http.
    const { request } = await import("node:http");
    const { port } = handle.server.address() as { port: number };

    function rawGet(path: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path },
          (res) => {
            res.resume(); // drain
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    }

    // `/api/memory/%E0%A4%A/pin` — `%A` is a truncated escape → URIError on decode.
    expect(await rawGet("/api/memory/%E0%A4%A/pin")).toBe(400);
    // `/api/agent/%/mute` — lone percent → URIError on decode.
    expect(await rawGet("/api/agent/%/mute")).toBe(400);
  });
});
