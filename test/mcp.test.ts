import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryMeter } from "../src/meter/inMemoryMeter.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { ThriftMcpServer } from "../src/mcp/server.js";

const T0 = 1_000_000_000_000;

function makeServer() {
  return new ThriftMcpServer({
    store: new JsonlStore(),
    retriever: new ScopedRetriever(),
    meter: new InMemoryMeter(),
  });
}

describe("ThriftMcpServer.remember", () => {
  it("stores an org memory and returns the record", () => {
    const srv = makeServer();
    const rec = srv.remember({ scope: "org", text: "company-wide rule" }, T0);
    expect(rec.text).toBe("company-wide rule");
    expect(rec.scope).toBe("org");
    expect(rec.tokens).toBeGreaterThan(0);
    expect(rec.id).toBeTruthy();
  });

  it("stores an agent-scoped memory", () => {
    const srv = makeServer();
    const rec = srv.remember({ scope: "agent", agentId: "dev", text: "dev uses vitest" }, T0);
    expect(rec.agentId).toBe("dev");
    expect(rec.scope).toBe("agent");
  });

  it("throws when agent scope is missing agentId", () => {
    const srv = makeServer();
    expect(() => srv.remember({ scope: "agent", text: "missing id" }, T0)).toThrow();
  });

  it("pinned flag is stored", () => {
    const srv = makeServer();
    const rec = srv.remember({ scope: "org", text: "always inject this", pinned: true }, T0);
    expect(rec.pinned).toBe(true);
  });
});

describe("ThriftMcpServer.recall", () => {
  it("returns relevant memories under budget with a savings receipt", () => {
    const srv = makeServer();
    srv.remember({ scope: "org", text: "company uses TypeScript for all services" }, T0);
    srv.remember({ scope: "agent", agentId: "dev", text: "dev agent specialises in TypeScript" }, T0 + 1);
    const result = srv.recall({ agentId: "dev", task: "TypeScript refactor", tokenBudget: 10_000 }, T0 + 2);
    expect(result.memories.length).toBeGreaterThan(0);
    expect(result.injectedTokens).toBeLessThanOrEqual(10_000);
    expect(result.savedTokens).toBe(result.baselineTokens - result.injectedTokens);
  });

  it("records a meter event per recall", () => {
    const meter = new InMemoryMeter();
    const srv = new ThriftMcpServer({
      store: new JsonlStore(),
      retriever: new ScopedRetriever(),
      meter,
    });
    srv.remember({ scope: "org", text: "org context text here" }, T0);
    srv.recall({ agentId: "bot", task: "anything", tokenBudget: 200 }, T0 + 1);
    const rollup = meter.rollupByAgent("bot");
    expect(rollup.runs).toBe(1);
    expect(rollup.injectedTokens).toBeGreaterThanOrEqual(0);
  });

  it("enforces the hard token budget", () => {
    const srv = makeServer();
    for (let i = 0; i < 10; i++) {
      srv.remember({ scope: "org", text: "x".repeat(40) }, T0 + i);
    }
    const result = srv.recall({ agentId: "dev", tokenBudget: 25 }, T0 + 10);
    expect(result.injectedTokens).toBeLessThanOrEqual(25);
  });

  it("uses defaultTokenBudget when no budget provided in args (via server default)", () => {
    const srv = new ThriftMcpServer({
      store: new JsonlStore(),
      retriever: new ScopedRetriever(),
      defaultTokenBudget: 50,
    });
    for (let i = 0; i < 20; i++) srv.remember({ scope: "org", text: "x".repeat(40) }, T0 + i);
    const result = srv.recall({ agentId: "dev", tokenBudget: 50 }, T0 + 20);
    expect(result.injectedTokens).toBeLessThanOrEqual(50);
  });
});

describe("ThriftMcpServer.searchMemory", () => {
  it("returns all in-scope matching memories without a budget cut-off", () => {
    const srv = makeServer();
    for (let i = 0; i < 5; i++) {
      srv.remember({ scope: "org", text: `memory ${i} about auth oauth login` }, T0 + i);
    }
    const results = srv.searchMemory({ agentId: "dev", task: "auth login" });
    expect(results.length).toBe(5);
  });

  it("respects the limit cap", () => {
    const srv = makeServer();
    for (let i = 0; i < 6; i++) srv.remember({ scope: "org", text: `note ${i}` }, T0 + i);
    const results = srv.searchMemory({ agentId: "dev", limit: 3 });
    expect(results.length).toBe(3);
  });

  it("filters by tag", () => {
    const srv = makeServer();
    srv.remember({ scope: "org", text: "thrift note", tags: ["thirft"] }, T0);
    srv.remember({ scope: "org", text: "project beta note", tags: ["project-beta"] }, T0 + 1);
    const results = srv.searchMemory({ agentId: "dev", tags: ["thirft"] });
    expect(results.length).toBe(1);
    expect(results[0].text).toBe("thrift note");
  });

  it("returns empty array when no memories exist", () => {
    const srv = makeServer();
    const results = srv.searchMemory({ agentId: "nobody" });
    expect(results).toEqual([]);
  });
});

describe("ThriftMcpServer.recall - quality-pairing fields (THRIFT-QUALITY-PAIRING)", () => {
  it("persists mode/taskId/outcome onto the JSONL meter row when supplied", () => {
    const dir = mkdtempSync(join(tmpdir(), "thrift-ab-"));
    const meterLogPath = join(dir, "meter.jsonl");
    try {
      const srv = new ThriftMcpServer({
        store: new JsonlStore(),
        retriever: new ScopedRetriever(),
        meter: new InMemoryMeter(),
        meterLogPath,
      });
      srv.remember({ scope: "org", text: "org context for pairing" }, T0);
      srv.recall(
        { agentId: "bug-reviewer", task: "review diff", tokenBudget: 200, mode: "thin", taskId: "REVIEW-1", outcome: "pass", synthetic: true },
        T0 + 1,
      );
      const row = JSON.parse(readFileSync(meterLogPath, "utf8").trim().split("\n").pop()!);
      expect(row.mode).toBe("thin");
      expect(row.taskId).toBe("REVIEW-1");
      expect(row.outcome).toBe("pass");
      // The synthetic flag survives the recall-to-meter-row write so reports can exclude it.
      expect(row.synthetic).toBe(true);
      // existing receipt fields still present and consistent
      expect(row.agentId).toBe("bug-reviewer");
      expect(row.savedTokens).toBe(row.baselineTokens - row.injectedTokens);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits pairing fields from the meter row when the caller does not supply them", () => {
    const dir = mkdtempSync(join(tmpdir(), "thrift-ab-"));
    const meterLogPath = join(dir, "meter.jsonl");
    try {
      const srv = new ThriftMcpServer({
        store: new JsonlStore(),
        retriever: new ScopedRetriever(),
        meter: new InMemoryMeter(),
        meterLogPath,
      });
      srv.remember({ scope: "org", text: "org context" }, T0);
      srv.recall({ agentId: "dev", tokenBudget: 200 }, T0 + 1);
      const row = JSON.parse(readFileSync(meterLogPath, "utf8").trim().split("\n").pop()!);
      expect(row).not.toHaveProperty("mode");
      expect(row).not.toHaveProperty("taskId");
      expect(row).not.toHaveProperty("outcome");
      expect(row).not.toHaveProperty("synthetic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
