import { describe, expect, it } from "vitest";
import { InMemoryMeter } from "../src/meter/inMemoryMeter.js";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";

const T0 = 1_000_000_000_000;

describe("InMemoryMeter rollups", () => {
  it("aggregates per-agent savings and ratio", () => {
    const m = new InMemoryMeter();
    m.record({ at: T0, agentId: "dev", injectedTokens: 20, baselineTokens: 100 });
    m.record({ at: T0 + 1, agentId: "dev", injectedTokens: 30, baselineTokens: 100 });

    const r = m.rollupByAgent("dev");
    expect(r.runs).toBe(2);
    expect(r.injectedTokens).toBe(50);
    expect(r.baselineTokens).toBe(200);
    expect(r.savedTokens).toBe(150);
    expect(r.savingsRatio).toBeCloseTo(0.75);
  });

  it("returns a zeroed rollup (ratio 0, no divide-by-zero) for an unknown agent", () => {
    const r = new InMemoryMeter().rollupByAgent("nobody");
    expect(r.runs).toBe(0);
    expect(r.savingsRatio).toBe(0);
  });

  it("rolls up the whole fleet, biggest savers first", () => {
    const m = new InMemoryMeter();
    m.record({ at: T0, agentId: "dev", injectedTokens: 10, baselineTokens: 50 });
    m.record({ at: T0, agentId: "qa", injectedTokens: 10, baselineTokens: 200 });
    const fleet = m.rollupFleet();
    expect(fleet.map((a) => a.agentId)).toEqual(["qa", "dev"]); // qa saved more
    expect(fleet[0].savedTokens).toBe(190);
  });

  it("filters by time window", () => {
    const m = new InMemoryMeter();
    m.record({ at: T0, agentId: "dev", injectedTokens: 10, baselineTokens: 100 });
    m.record({ at: T0 + 1000, agentId: "dev", injectedTokens: 10, baselineTokens: 100 });
    expect(m.rollupByAgent("dev", T0 + 500).runs).toBe(1);
  });

  it("meters a real recall result end-to-end", () => {
    const store = new JsonlStore();
    for (let i = 0; i < 4; i++) store.add({ scope: "org", text: "x".repeat(40) }, T0 + i);
    const result = new ScopedRetriever().recall(store, { agentId: "dev", tokenBudget: 20 });

    const meter = new InMemoryMeter();
    meter.recordRecall("dev", T0, result);

    const roll = meter.rollupByAgent("dev");
    expect(roll.injectedTokens).toBe(result.injectedTokens);
    expect(roll.baselineTokens).toBe(result.baselineTokens);
    expect(roll.savedTokens).toBeGreaterThan(0);
  });
});
