import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlStore } from "../src/store/jsonlStore.js";
import { FileMemoryStore } from "../src/store/fileMemoryStore.js";
import { CompositeMemoryStore } from "../src/store/compositeMemoryStore.js";
import { ScopedRetriever } from "../src/retrieval/scopedRetriever.js";

const T0 = 1_000_000_000_000; // fixed epoch so tests never read the wall clock

describe("JsonlStore (in-memory)", () => {
  it("adds and reads back a memory with estimated tokens", () => {
    const s = new JsonlStore();
    const m = s.add({ scope: "org", text: "company runs 20 agents daily" }, T0);
    expect(m.id).toBeTruthy();
    expect(m.tokens).toBeGreaterThan(0);
    expect(s.get(m.id)?.text).toBe("company runs 20 agents daily");
  });

  it("enforces scope invariants", () => {
    const s = new JsonlStore();
    expect(() => s.add({ scope: "agent", text: "x" }, T0)).toThrow(/agentId/);
    expect(() => s.add({ scope: "session", text: "x" }, T0)).toThrow(/sessionId/);
  });

  it("updates text and recomputes tokens", () => {
    const s = new JsonlStore();
    const m = s.add({ scope: "org", text: "short" }, T0);
    const longer = "a".repeat(80);
    const updated = s.update(m.id, { text: longer }, T0 + 1);
    expect(updated?.tokens).toBe(20);
    expect(updated?.updatedAt).toBe(T0 + 1);
  });

  it("filters list by scope and agent", () => {
    const s = new JsonlStore();
    s.add({ scope: "org", text: "org fact" }, T0);
    s.add({ scope: "agent", agentId: "dev", text: "dev fact" }, T0);
    s.add({ scope: "agent", agentId: "qa", text: "qa fact" }, T0);
    expect(s.list({ scope: "org" })).toHaveLength(1);
    expect(s.list({ scope: "agent", agentId: "dev" })).toHaveLength(1);
  });

  it("removes a memory", () => {
    const s = new JsonlStore();
    const m = s.add({ scope: "org", text: "x" }, T0);
    expect(s.remove(m.id)).toBe(true);
    expect(s.get(m.id)).toBeUndefined();
    expect(s.remove(m.id)).toBe(false);
  });
});

describe("JsonlStore (persistence)", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thrift-"));
    path = join(dir, "mem.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replays the log to rebuild state across instances", () => {
    const a = new JsonlStore({ path });
    const m = a.add({ scope: "org", text: "persist me" }, T0);
    a.add({ scope: "agent", agentId: "dev", text: "dev only" }, T0);
    a.remove(a.add({ scope: "org", text: "temp" }, T0).id);

    const b = new JsonlStore({ path });
    expect(b.get(m.id)?.text).toBe("persist me");
    expect(b.list()).toHaveLength(2); // temp was removed
  });

  it("skips a corrupt log line instead of crashing the whole load", () => {
    const rec = (id: string, text: string) =>
      JSON.stringify({
        op: "put",
        record: {
          id, scope: "org", text, pinned: false, disabled: false,
          tokens: 1, createdAt: T0, updatedAt: T0,
        },
      });
    // A half-written middle line (e.g. a crash mid-append) sits between two good ones.
    writeFileSync(path, rec("a", "alpha") + "\n" + '{"op":"put","record":{ oops' + "\n" + rec("b", "bravo") + "\n");

    let s: JsonlStore | undefined;
    expect(() => (s = new JsonlStore({ path }))).not.toThrow(); // load must survive
    expect(s!.get("a")?.text).toBe("alpha");
    expect(s!.get("b")?.text).toBe("bravo"); // the good line AFTER the corrupt one still loads
    expect(s!.list()).toHaveLength(2);
    expect(s!.corruptLinesSkipped).toEqual([2]); // the bad line number is recorded
  });

  it("compaction preserves live records and drops tombstones", () => {
    const a = new JsonlStore({ path });
    const keep = a.add({ scope: "org", text: "keep" }, T0);
    a.remove(a.add({ scope: "org", text: "gone" }, T0).id);
    a.compact();

    const b = new JsonlStore({ path });
    expect(b.list()).toHaveLength(1);
    expect(b.get(keep.id)?.text).toBe("keep");
  });

  // QA-1 (THIRFT-M5): dedicated coverage of the compact() delete path —
  // the four destructive-persistence dimensions (survivors load, targets gone,
  // no duplicates, file still valid). compact() drops *tombstoned* (removed)
  // records and collapses superseded versions; disabled-but-present records are
  // still live in the index, so they MUST survive compaction unchanged.
  it("compact() drops removed records, keeps survivors, leaves a valid JSONL file", () => {
    const a = new JsonlStore({ path });
    // 5 records; two will be removed (tombstoned) before compaction.
    const k1 = a.add({ scope: "org", text: "keep one" }, T0);
    const d1 = a.add({ scope: "org", text: "delete one" }, T0);
    const k2 = a.add({ scope: "agent", agentId: "dev", text: "keep two" }, T0);
    const d2 = a.add({ scope: "org", text: "delete two" }, T0);
    const k3 = a.add({ scope: "session", sessionId: "s1", text: "keep three" }, T0);

    expect(a.remove(d1.id)).toBe(true);
    expect(a.remove(d2.id)).toBe(true);

    // Before compaction the on-disk log carries every op (5 puts + 2 dels = 7).
    const linesBefore = readFileSync(path, "utf8").trim().split("\n");
    expect(linesBefore).toHaveLength(7);

    a.compact();

    // (d) Underlying file is still valid JSONL: exactly one "put" per survivor,
    //     every line parses, and no tombstones remain.
    const rawAfter = readFileSync(path, "utf8");
    const linesAfter = rawAfter.trim().split("\n");
    expect(linesAfter).toHaveLength(3); // (c) no duplicates: exactly 3 survivors
    const parsed = linesAfter.map((l) => JSON.parse(l)); // throws if any line is malformed
    expect(parsed.every((e) => e.op === "put")).toBe(true);
    expect(rawAfter.endsWith("\n")).toBe(true); // not truncated mid-line

    // Re-load from disk to prove compaction is durable, not just in-memory.
    const b = new JsonlStore({ path });

    // (a) survivors still load correctly, sampled by ID, with intact fields.
    expect(b.get(k1.id)?.text).toBe("keep one");
    expect(b.get(k2.id)?.text).toBe("keep two");
    expect(b.get(k2.id)?.agentId).toBe("dev");
    expect(b.get(k3.id)?.sessionId).toBe("s1");

    // (b) targeted (removed) records are gone — absent from the reloaded store.
    expect(b.get(d1.id)).toBeUndefined();
    expect(b.get(d2.id)).toBeUndefined();

    // (c) exact count: 3 survivors, no resurrections, no duplicates.
    expect(b.list()).toHaveLength(3);
  });

  it("compact() retains disabled-but-present records (disable != delete)", () => {
    const a = new JsonlStore({ path });
    const live = a.add({ scope: "org", text: "active" }, T0);
    const off = a.add({ scope: "org", text: "soft-disabled" }, T0);
    // update() with disabled:true does NOT tombstone — the record stays in the index.
    a.update(off.id, { disabled: true }, T0 + 1);

    a.compact();

    const b = new JsonlStore({ path });
    expect(b.list()).toHaveLength(2); // both survive compaction
    expect(b.get(live.id)?.disabled).toBe(false);
    expect(b.get(off.id)?.disabled).toBe(true); // disabled flag preserved
    expect(b.get(off.id)?.updatedAt).toBe(T0 + 1);
  });

  // THIRFT-COMPACT-TEST: gaps the QA-1 tests above left open.

  // Backs the compact() doc-comment guarantee that it "collapses superseded
  // versions" (AP-T29: an untested guarantee is a spec lie). Every update()
  // appends another "put" line for the SAME id; compaction must shrink the log
  // to exactly one current line per record while keeping the LATEST value.
  it("compact() collapses superseded versions to one line per record (keeps latest)", () => {
    const a = new JsonlStore({ path });
    const m = a.add({ scope: "org", text: "v1" }, T0);
    a.update(m.id, { text: "v2" }, T0 + 1);
    a.update(m.id, { text: "v3" }, T0 + 2);
    a.update(m.id, { text: "v4" }, T0 + 3);

    // 1 add + 3 updates = 4 "put" lines on disk for a single record.
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(4);

    a.compact();

    // Log shrinks to a single current line; no superseded versions remain.
    const linesAfter = readFileSync(path, "utf8").trim().split("\n");
    expect(linesAfter).toHaveLength(1);
    const entry = JSON.parse(linesAfter[0]);
    expect(entry.op).toBe("put");
    expect(entry.record.text).toBe("v4");
    expect(entry.record.updatedAt).toBe(T0 + 3);

    // Durable across reload: exactly one record, holding the latest value.
    const b = new JsonlStore({ path });
    expect(b.list()).toHaveLength(1);
    expect(b.get(m.id)?.text).toBe("v4");
  });

  // The lines.length ? ... : "" branch in compact(): when every record has been
  // removed, compaction must truncate the file to empty (not leave tombstones),
  // and a reload must yield an empty, still-valid store.
  it("compact() empties the file when no records remain", () => {
    const a = new JsonlStore({ path });
    const m = a.add({ scope: "org", text: "soon gone" }, T0);
    a.remove(m.id);

    a.compact();

    expect(readFileSync(path, "utf8")).toBe(""); // empty, not a tombstone line
    const b = new JsonlStore({ path });
    expect(b.list()).toHaveLength(0); // valid empty store reloads cleanly
  });

  // compact() must be idempotent: a second call on an already-compacted log
  // produces byte-identical output and never resurrects or duplicates records.
  it("compact() is idempotent (second call is a no-op on the bytes)", () => {
    const a = new JsonlStore({ path });
    a.add({ scope: "org", text: "alpha" }, T0);
    const drop = a.add({ scope: "org", text: "beta" }, T0);
    a.add({ scope: "agent", agentId: "dev", text: "gamma" }, T0);
    a.remove(drop.id);

    a.compact();
    const first = readFileSync(path, "utf8");
    a.compact();
    const second = readFileSync(path, "utf8");

    expect(second).toBe(first); // byte-identical
    expect(first.trim().split("\n")).toHaveLength(2); // alpha + gamma survive
    expect(new JsonlStore({ path }).list()).toHaveLength(2);
  });
});

describe("JsonlStore.compact() (no persistence path)", () => {
  // A pure in-memory store has no file; compact() must be a safe no-op and must
  // not drop, mutate, or throw on the in-memory records (early return guard).
  it("is a no-op and never touches in-memory records", () => {
    const s = new JsonlStore();
    const a = s.add({ scope: "org", text: "one" }, T0);
    const gone = s.add({ scope: "org", text: "two" }, T0);
    s.remove(gone.id);

    expect(() => s.compact()).not.toThrow();
    expect(s.list()).toHaveLength(1);
    expect(s.get(a.id)?.text).toBe("one");
    expect(s.get(gone.id)).toBeUndefined();
  });
});

describe("FileMemoryStore + CompositeMemoryStore", () => {
  let dir: string;
  let memPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thrift-file-store-"));
    memPath = join(dir, "memories.jsonl");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads root memory files as org-scoped recallable records", () => {
    writeFileSync(
      join(dir, "MEMORY.md"),
      "# Payments\n\nAll money values are stored as integer cents.",
    );

    const store = new FileMemoryStore({ rootDir: dir });
    const out = new ScopedRetriever().recall(store, {
      agentId: "dev",
      task: "how should payments store integer cents",
      tokenBudget: 1_000,
    });

    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].id).toMatch(/^file:/);
    expect(out.memories[0].scope).toBe("org");
    expect(out.memories[0].tags).toContain("source:file");
    expect(out.memories[0].text).toContain("integer cents");
  });

  it("picks up edits to source files on the next read", () => {
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "The deploy flow uses canary releases.");
    const store = new FileMemoryStore({ rootDir: dir });

    expect(store.list()[0].text).toContain("canary");

    writeFileSync(path, "The billing flow uses Stripe webhooks.");
    const out = new ScopedRetriever().recall(store, {
      agentId: "dev",
      task: "billing stripe webhooks",
      tokenBudget: 1_000,
    });

    expect(out.memories).toHaveLength(1);
    expect(out.memories[0].text).toContain("Stripe webhooks");
  });

  it("includes rule-directory files and ignores nested root-context copies", () => {
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "api.mdc"), "API handlers validate auth tokens.");
    mkdirSync(join(dir, "packages", "api"), { recursive: true });
    writeFileSync(join(dir, "packages", "api", "AGENTS.md"), "Nested agent note should not auto-load.");

    const texts = new FileMemoryStore({ rootDir: dir }).list().map((m) => m.text);

    expect(texts.some((t) => t.includes("auth tokens"))).toBe(true);
    expect(texts.some((t) => t.includes("Nested agent note"))).toBe(false);
  });

  it("maps memory/<agentId>/*.md to agent-scoped file memories dynamically", () => {
    mkdirSync(join(dir, "memory", "takshi"), { recursive: true });
    mkdirSync(join(dir, "memory", "qa-manager"), { recursive: true });
    writeFileSync(join(dir, "memory", "takshi", "crm.md"), "Takshi CRM has overdue buyer follow-ups.");
    writeFileSync(join(dir, "memory", "qa-manager", "smoke.md"), "QA smoke tests cover the proxy health check.");

    const store = new FileMemoryStore({ rootDir: dir });
    const takshi = new ScopedRetriever().recall(store, {
      agentId: "takshi",
      task: "overdue buyer follow-ups crm",
      tokenBudget: 1_000,
    });
    const qa = new ScopedRetriever().recall(store, {
      agentId: "qa-manager",
      task: "proxy health smoke tests",
      tokenBudget: 1_000,
    });
    const dev = new ScopedRetriever().recall(store, {
      agentId: "dev",
      task: "overdue buyer follow-ups crm proxy health",
      tokenBudget: 1_000,
    });

    expect(takshi.memories.map((m) => m.text)).toContain("Takshi CRM has overdue buyer follow-ups.");
    expect(takshi.memories[0].scope).toBe("agent");
    expect(takshi.memories[0].agentId).toBe("takshi");
    expect(takshi.memories[0].tags).toContain("agent:takshi");
    expect(qa.memories.map((m) => m.text)).toContain("QA smoke tests cover the proxy health check.");
    expect(qa.memories[0].agentId).toBe("qa-manager");
    expect(dev.memories).toHaveLength(0);
  });

  // BUG-THRFT: agentId derivation used to lowercase the whole path, so a
  // mixed-case dir memory/MyAgent/ was classified as agentId "myagent" and could
  // never be recalled by the caller's real agentId "MyAgent" (unmatchable
  // recall). The fix preserves on-disk casing, matching how the writable
  // JsonlStore already stores agentId verbatim.
  //
  // NOTE: this asserts casing is PRESERVED, not that recall is case-insensitive.
  // We deliberately do not fabricate two sibling dirs (memory/MyAgent +
  // memory/myagent) because on a case-insensitive filesystem (Windows/macOS)
  // they collapse to one dir and the fixture would not represent the real bug.
  it("preserves on-disk casing of a mixed-case agent dir (matchable recall, no case-fold)", () => {
    mkdirSync(join(dir, "memory", "MixedCaseAgent"), { recursive: true });
    writeFileSync(
      join(dir, "memory", "MixedCaseAgent", "notes.md"),
      "MixedCaseAgent note about deploy canaries.",
    );

    const store = new FileMemoryStore({ rootDir: dir });

    // Classification preserves the exact on-disk casing (not "mixedcaseagent").
    const rec = store.list({ scope: "agent" });
    expect(rec).toHaveLength(1);
    expect(rec[0].agentId).toBe("MixedCaseAgent");
    expect(rec[0].tags).toContain("agent:MixedCaseAgent");

    // Recall by the caller's real (matching) agentId returns the note — this is
    // the "unmatchable recall" regression the old lowercasing caused.
    const match = new ScopedRetriever().recall(store, {
      agentId: "MixedCaseAgent",
      task: "deploy canaries note",
      tokenBudget: 1_000,
    });
    expect(match.memories.map((m) => m.text)).toEqual([
      "MixedCaseAgent note about deploy canaries.",
    ]);
    expect(match.memories[0].agentId).toBe("MixedCaseAgent");

    // A caller with a different casing must NOT match — recall stays strict, so
    // memories cannot bleed across agents that differ only by case.
    const folded = new ScopedRetriever().recall(store, {
      agentId: "mixedcaseagent",
      task: "deploy canaries note",
      tokenBudget: 1_000,
    });
    expect(folded.memories).toHaveLength(0);
  });

  it("does not treat shared memory folders like reports as agent ids", () => {
    mkdirSync(join(dir, "memory", "reports"), { recursive: true });
    writeFileSync(join(dir, "memory", "reports", "takshi.md"), "Report-only text should not become agent memory.");

    const store = new FileMemoryStore({ rootDir: dir });

    expect(store.list()).toHaveLength(0);
  });

  it("merges file-backed records with the writable JSONL overlay", () => {
    writeFileSync(join(dir, "MEMORY.md"), "Frontend uses server-rendered forms.");
    const writable = new JsonlStore({ path: memPath });
    const store = new CompositeMemoryStore({
      writable,
      sources: [new FileMemoryStore({ rootDir: dir })],
    });

    store.add({ scope: "org", text: "Backend stores money as integer cents." }, T0);
    const out = new ScopedRetriever().recall(store, {
      agentId: "dev",
      tokenBudget: 1_000,
    });
    const texts = out.memories.map((m) => m.text);

    expect(texts).toContain("Frontend uses server-rendered forms.");
    expect(texts).toContain("Backend stores money as integer cents.");
    expect(new JsonlStore({ path: memPath }).list()).toHaveLength(1);
  });

  it("reloads the writable JSONL overlay before recall so external dashboard edits apply", () => {
    const writable = new JsonlStore({ path: memPath });
    const store = new CompositeMemoryStore({ writable });
    const memory = store.add({ scope: "org", text: "Disable this deployment memory." }, T0);

    const external = new JsonlStore({ path: memPath });
    external.update(memory.id, { disabled: true }, T0 + 1);

    const out = new ScopedRetriever().recall(store, {
      agentId: "dev",
      tokenBudget: 1_000,
    });

    expect(out.memories).toHaveLength(0);
    expect(out.baselineTokens).toBe(0);
  });
});
