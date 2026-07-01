import { describe, expect, it } from "vitest";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";

const T0 = 1_000_000_000_000;

function seed() {
  const s = new JsonlStore();
  s.add({ scope: "org", text: "the company runs twenty agents every day" }, T0);
  s.add({ scope: "agent", agentId: "dev", text: "developer uses typescript and vitest" }, T0 + 1);
  s.add({ scope: "agent", agentId: "qa", text: "qa runs playwright smoke tests" }, T0 + 2);
  s.add({ scope: "session", sessionId: "sess1", text: "current task: fix the login bug" }, T0 + 3);
  return s;
}

describe("ScopedRetriever scoping", () => {
  it("includes org + this agent + this session, excludes other agents", () => {
    const s = seed();
    const r = new ScopedRetriever();
    const out = r.recall(s, { agentId: "dev", sessionId: "sess1", tokenBudget: 10_000 });
    const texts = out.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("twenty agents"))).toBe(true); // org
    expect(texts.some((t) => t.includes("typescript"))).toBe(true); // dev agent
    expect(texts.some((t) => t.includes("login bug"))).toBe(true); // session
    expect(texts.some((t) => t.includes("playwright"))).toBe(false); // qa agent excluded
  });

  it("omits session memories when no sessionId is given", () => {
    const s = seed();
    const out = new ScopedRetriever().recall(s, { agentId: "dev", tokenBudget: 10_000 });
    expect(out.memories.some((m) => m.text.includes("login bug"))).toBe(false);
  });
});

describe("ScopedRetriever budget + receipt", () => {
  it("never exceeds the hard token budget and reports real savings", () => {
    const s = new JsonlStore();
    // 5 org memories of ~10 tokens each (40 chars / 4).
    for (let i = 0; i < 5; i++) s.add({ scope: "org", text: "x".repeat(40) }, T0 + i);
    const out = new ScopedRetriever().recall(s, { agentId: "dev", tokenBudget: 25 });

    expect(out.injectedTokens).toBeLessThanOrEqual(25);
    expect(out.memories.length).toBe(2); // 2 * 10 = 20 fits, a 3rd would be 30
    expect(out.baselineTokens).toBe(50); // all 5 in scope
    expect(out.savedTokens).toBe(out.baselineTokens - out.injectedTokens);
    expect(out.savedTokens).toBeGreaterThan(0);
  });

  it("ranks task-relevant memories ahead of irrelevant ones", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "kubernetes deployment manifests and helm charts" }, T0);
    s.add({ scope: "org", text: "the login authentication flow uses oauth tokens" }, T0 + 1);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "debug the login authentication oauth problem",
      tokenBudget: 15, // only room for one
    });
    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].text).toContain("login authentication");
  });

  it("pinned memories get first claim on the budget", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "unrelated trivia about something else entirely here" }, T0);
    s.add({ scope: "org", text: "PINNED house rule never push to git", pinned: true }, T0 + 1);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "trivia something",
      tokenBudget: 15,
    });
    expect(out.memories[0].pinned).toBe(true);
  });

  it("respects the tag filter (pinned bypasses it)", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "thrift project note", tags: ["thirft"] }, T0);
    s.add({ scope: "org", text: "project beta note", tags: ["project-beta"] }, T0 + 1);
    s.add({ scope: "org", text: "global pinned note", pinned: true }, T0 + 2);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      tags: ["thirft"],
      tokenBudget: 10_000,
    });
    const texts = out.memories.map((m) => m.text);
    expect(texts).toContain("thrift project note");
    expect(texts).toContain("global pinned note"); // pinned bypasses tag filter
    expect(texts).not.toContain("project beta note");
  });

  it("baseline counts the FULL in-scope set, not the tag-filtered subset (THIRFT-BUG-001)", () => {
    const s = new JsonlStore();
    // 3 in-scope org memories of ~10 tokens each (40 chars / 4); only one carries the queried tag.
    s.add({ scope: "org", text: "x".repeat(40), tags: ["thirft"] }, T0);
    s.add({ scope: "org", text: "y".repeat(40), tags: ["project-beta"] }, T0 + 1);
    s.add({ scope: "org", text: "z".repeat(40), tags: ["project-gamma"] }, T0 + 2);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      tags: ["thirft"],
      tokenBudget: 10_000,
    });
    // Only the thirft-tagged memory is injected...
    expect(out.injectedTokens).toBe(10);
    expect(out.memories).toHaveLength(1);
    // ...but the naive "load everything in scope" baseline is all 3 (30), so the
    // tag filter's savings are credited — not understated to 10 (which would report 0 saved).
    expect(out.baselineTokens).toBe(30);
    expect(out.savedTokens).toBe(20);
  });

  it("relevance floor: drops zero-overlap memories when the task has terms (even if they fit)", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "the login authentication flow uses oauth tokens" }, T0);
    s.add({ scope: "org", text: "kubernetes deployment manifests and helm charts" }, T0 + 1);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "debug the login oauth problem",
      tokenBudget: 10_000, // ample room for both — only relevance should exclude one
    });
    const texts = out.memories.map((m) => m.text);
    expect(texts).toContain("the login authentication flow uses oauth tokens");
    expect(texts.some((t) => t.includes("kubernetes"))).toBe(false); // zero overlap, excluded
    // Baseline still counts the full in-scope set, so the irrelevant memory's
    // tokens are credited as savings, not silently dropped from the receipt.
    expect(out.baselineTokens).toBeGreaterThan(out.injectedTokens);
    expect(out.savedTokens).toBe(out.baselineTokens - out.injectedTokens);
  });

  it("relevance floor is OFF when there is no task text (pack by recency under budget)", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "x".repeat(40) }, T0);
    s.add({ scope: "org", text: "y".repeat(40) }, T0 + 1);
    const out = new ScopedRetriever().recall(s, { agentId: "dev", tokenBudget: 10_000 });
    expect(out.memories).toHaveLength(2); // no task → nothing to be (ir)relevant to
  });

  it("pinned memories bypass the relevance floor", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "PINNED house rule never push to git", pinned: true }, T0);
    s.add({ scope: "org", text: "the login oauth authentication flow" }, T0 + 1);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "login oauth",
      tokenBudget: 10_000,
    });
    const texts = out.memories.map((m) => m.text);
    expect(texts.some((t) => t.includes("PINNED house rule"))).toBe(true); // pinned, zero overlap, kept
    expect(texts.some((t) => t.includes("login oauth"))).toBe(true);
  });

  it("budget pressure: signals when relevant memory was dropped for budget (not relevance)", () => {
    const s = new JsonlStore();
    // 4 relevant memories of exactly 10 tokens each ("login " + 34 chars = 40 chars / 4).
    // Each contains the query term "login" so it clears the relevance floor.
    for (let i = 0; i < 4; i++) {
      s.add({ scope: "org", text: "login " + String.fromCharCode(97 + i).repeat(34) }, T0 + i);
    }
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "login oauth token flow",
      tokenBudget: 25, // fits 2 (20 tok); a 3rd would be 30 > 25
    });
    expect(out.memories.length).toBe(2); // only 2 fit
    expect(out.relevantTokens).toBe(40); // all 4 cleared the relevance floor
    expect(out.skippedForBudget).toBe(2); // 2 relevant memories didn't fit
    expect(out.skippedTokensForBudget).toBe(out.relevantTokens - out.injectedTokens);
    expect(out.hasMoreRelevantMemory).toBe(true);
    expect(out.budgetPressure).toBe("high"); // as much relevant memory skipped as injected
  });

  it("budget pressure is 'none' when everything relevant fits", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "login oauth token flow note" }, T0);
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "login oauth token flow",
      tokenBudget: 10_000, // ample
    });
    expect(out.hasMoreRelevantMemory).toBe(false);
    expect(out.skippedForBudget).toBe(0);
    expect(out.skippedTokensForBudget).toBe(0);
    expect(out.budgetPressure).toBe("none");
    expect(out.relevantTokens).toBe(out.injectedTokens);
  });

  it("budget pressure does NOT fire for memory dropped by the relevance floor (only budget counts)", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "login oauth token flow" }, T0); // relevant, fits
    s.add({ scope: "org", text: "kubernetes helm chart deployment manifests" }, T0 + 1); // irrelevant
    const out = new ScopedRetriever().recall(s, {
      agentId: "dev",
      task: "login oauth token flow",
      tokenBudget: 10_000,
    });
    // The irrelevant memory was dropped by the floor, not the budget — so it must
    // NOT show up as budget pressure ("more relevant memory exists" would be a lie).
    expect(out.hasMoreRelevantMemory).toBe(false);
    expect(out.budgetPressure).toBe("none");
    expect(out.skippedForBudget).toBe(0);
  });

  it("excludes disabled memories entirely", () => {
    const s = new JsonlStore();
    const m = s.add({ scope: "org", text: "disabled secret note" }, T0);
    s.update(m.id, { disabled: true }, T0 + 1);
    const out = new ScopedRetriever().recall(s, { agentId: "dev", tokenBudget: 10_000 });
    expect(out.memories).toHaveLength(0);
    expect(out.baselineTokens).toBe(0);
  });
});
