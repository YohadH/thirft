import { describe, expect, it } from "vitest";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";
import { buildSessionContext } from "../src/sessionContext.js";

const T0 = 1_000_000_000_000;

describe("buildSessionContext (SessionStart hook payload)", () => {
  it("renders a budgeted memory block with an honest receipt header", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "All money values are integer cents." }, T0);
    s.add({ scope: "org", text: "Deploy only on green CI." }, T0 + 1);
    s.add({ scope: "agent", agentId: "session-start", text: "Prefer small PRs." }, T0 + 2);

    const { lines, result } = buildSessionContext(s, new ScopedRetriever(), {
      agentId: "session-start",
      tokenBudget: 1_500,
    });

    expect(result).toBeDefined();
    expect(lines[0]).toMatch(/^## Thrift Memory \(auto-recalled \d+\/\d+ tokens — saved \d+\)$/);
    expect(lines).toContain("- All money values are integer cents.");
    expect(lines).toContain("- Prefer small PRs.");
    // Header numbers match the receipt.
    expect(lines[0]).toContain(`${result!.injectedTokens}/${result!.baselineTokens}`);
  });

  it("respects the hard budget (drops what does not fit)", () => {
    const s = new JsonlStore();
    for (let i = 0; i < 5; i++) s.add({ scope: "org", text: "x".repeat(40) }, T0 + i); // 10 tok each
    const { lines, result } = buildSessionContext(s, new ScopedRetriever(), {
      agentId: "session-start",
      tokenBudget: 25,
    });
    expect(result!.injectedTokens).toBeLessThanOrEqual(25);
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(2); // 2 * 10 fits, a 3rd would bust
  });

  it("stays SILENT on an empty store — a hook must not inject noise", () => {
    const s = new JsonlStore();
    const { lines, result } = buildSessionContext(s, new ScopedRetriever(), {
      agentId: "session-start",
      tokenBudget: 1_500,
    });
    expect(lines).toHaveLength(0);
    expect(result).toBeUndefined();
  });
});
