import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeStep,
  readTranscriptTail,
  windowForModel,
  checkContextWatch,
} from "../src/contextWatch.js";

const DEFAULT_OPTS = { stepPct: 20, minStepTokens: 80_000, maxStepPct: 50 };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "thrift-context-watch-"));
}

function writeTranscript(dir: string, lines: unknown[]): string {
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function assistantEntry(usage: Record<string, number>, model = "claude-sonnet-5"): unknown {
  return { type: "assistant", message: { model, usage } };
}

describe("computeStep (clamp math)", () => {
  const cases: Array<[number, number]> = [
    [1_000_000, 200_000], // 20% of 1M = 200k, within [80k, 500k]
    [200_000, 80_000], // 20% of 200k = 40k, clamped up to min 80k -> fires at 40%/80%
    [128_000, 64_000], // 20% of 128k = 25.6k, min 80k clamps... but maxStepPct 50% = 64k caps below min
    [32_000, 16_000], // 20% of 32k = 6.4k, min 80k, but max 50% = 16k caps it
  ];

  it.each(cases)("window %d -> step %d", (window, expected) => {
    expect(computeStep(window, DEFAULT_OPTS)).toBe(expected);
  });
});

describe("windowForModel", () => {
  it("defaults to 200k for unknown/undefined models", () => {
    expect(windowForModel(undefined)).toBe(200_000);
    expect(windowForModel("claude-sonnet-5")).toBe(200_000);
  });

  it("detects 1m-class models", () => {
    expect(windowForModel("claude-sonnet-5[1m]")).toBe(1_000_000);
    expect(windowForModel("claude-opus-4-1m")).toBe(1_000_000);
    expect(windowForModel("claude-opus-4_1m")).toBe(1_000_000);
  });

  it("does not misclassify a model id merely containing '1m' as a substring", () => {
    expect(windowForModel("some-model-1M-context")).toBe(200_000);
    expect(windowForModel("claude-haiku-51m")).toBe(200_000);
  });
});

describe("readTranscriptTail", () => {
  it("reads usage from the last assistant entry", () => {
    const dir = tmpDir();
    const p = writeTranscript(dir, [
      assistantEntry({ input_tokens: 100 }),
      { type: "user", message: { content: "hi" } },
      assistantEntry({
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
      }),
    ]);
    const tail = readTranscriptTail(p);
    expect(tail.usageTokens).toBe(1700);
    expect(tail.model).toBe("claude-sonnet-5");
  });

  it("treats missing usage subfields as 0", () => {
    const dir = tmpDir();
    const p = writeTranscript(dir, [assistantEntry({ input_tokens: 42 })]);
    const tail = readTranscriptTail(p);
    expect(tail.usageTokens).toBe(42);
  });

  it("falls back to fileSize/4 when no usable assistant usage entry exists", () => {
    const dir = tmpDir();
    const p = join(dir, "transcript.jsonl");
    const content = "x".repeat(400);
    writeFileSync(p, content);
    const tail = readTranscriptTail(p);
    expect(tail.usageTokens).toBe(100);
  });

  it("falls back to fileSize/4 on malformed JSONL lines", () => {
    const dir = tmpDir();
    const p = join(dir, "transcript.jsonl");
    const content = "not json\n{also not json";
    writeFileSync(p, content);
    const tail = readTranscriptTail(p);
    expect(tail.usageTokens).toBe(Math.floor(content.length / 4));
  });

  it("finds the usage entry near the end of a transcript larger than the bounded-read chunk, without reading the whole file", () => {
    const dir = tmpDir();
    const p = join(dir, "transcript.jsonl");
    // Many old lines, well past the 64 KB bounded-read chunk size.
    const oldLine = JSON.stringify({ type: "user", message: { content: "x".repeat(200) } });
    const oldLines = Array(2000).fill(oldLine); // ~450KB+ of old content
    const realUsageLine = JSON.stringify(
      assistantEntry({ input_tokens: 1234, cache_read_input_tokens: 6 }, "claude-sonnet-5"),
    );
    const content = [...oldLines, realUsageLine].join("\n") + "\n";
    writeFileSync(p, content);
    expect(content.length).toBeGreaterThan(64 * 1024);

    const tail = readTranscriptTail(p);
    expect(tail.usageTokens).toBe(1240);
    expect(tail.model).toBe("claude-sonnet-5");
  });
});

describe("checkContextWatch", () => {
  it("fires on first crossing with correct percentage", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [
      assistantEntry({ input_tokens: 90_000 }, "claude-sonnet-5"), // 45% of 200k, step=80k -> stepIndex 1
    ]);
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "s1" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("45%");
    expect(msg).toContain("hookSpecificOutput");
  });

  it("instructs checking search_memory for the session tag before saving, and tagging new memories the same way", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [
      assistantEntry({ input_tokens: 90_000 }, "claude-sonnet-5"), // 45% of 200k
    ]);
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "abc-123" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).not.toBeNull();
    const parsed = JSON.parse(msg as string) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toBe(
      "Context usage crossed 45% of the model's window — before saving, call " +
        'search_memory with tag "session:abc-123" to see what you already stored ' +
        "this session, then store only new durable facts via the Thrift remember " +
        'tool (tag them "session:abc-123" too), and suggest the user run /compact.',
    );
  });

  it("does not fire twice for the same step", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [assistantEntry({ input_tokens: 90_000 })]);
    const statePath = join(dir, "state");
    const opts = { ...DEFAULT_OPTS, statePath };
    const first = checkContextWatch({ transcriptPath, sessionId: "s1" }, opts);
    const second = checkContextWatch({ transcriptPath, sessionId: "s1" }, opts);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("fires again when crossing the next step", () => {
    const dir = tmpDir();
    const statePath = join(dir, "state");
    const opts = { ...DEFAULT_OPTS, statePath };

    const p1 = writeTranscript(dir, [assistantEntry({ input_tokens: 90_000 })]);
    const first = checkContextWatch({ transcriptPath: p1, sessionId: "s1" }, opts);
    expect(first).not.toBeNull();

    const p2 = writeTranscript(dir, [assistantEntry({ input_tokens: 170_000 })]); // 85%, stepIndex 2
    const second = checkContextWatch({ transcriptPath: p2, sessionId: "s1" }, opts);
    expect(second).not.toBeNull();
    expect(second).toContain("85%");
  });

  it("does not fire below the first step threshold", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [assistantEntry({ input_tokens: 10_000 })]); // 5%
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "s1" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).toBeNull();
  });

  it("honors --window-tokens override", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [
      assistantEntry({ input_tokens: 450_000 }, "claude-sonnet-5[1m]"),
    ]);
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "s1" },
      { ...DEFAULT_OPTS, statePath, windowTokens: 200_000 },
    );
    // With override window 200k instead of inferred 1M: 450k/200k = 225% -> should fire
    expect(msg).not.toBeNull();
    expect(msg).toContain("225%");
  });

  it("persists state across separate invocations for different sessions independently", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [assistantEntry({ input_tokens: 90_000 })]);
    const statePath = join(dir, "state");
    const opts = { ...DEFAULT_OPTS, statePath };
    const s1 = checkContextWatch({ transcriptPath, sessionId: "s1" }, opts);
    const s2 = checkContextWatch({ transcriptPath, sessionId: "s2" }, opts);
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
  });

  it("returns null and does not throw on missing transcript file", () => {
    const dir = tmpDir();
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath: join(dir, "does-not-exist.jsonl"), sessionId: "s1" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).toBeNull();
  });

  it("returns null and does not throw on an unsafe sessionId (path traversal)", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [assistantEntry({ input_tokens: 90_000 })]);
    const statePath = join(dir, "state");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "../../etc/passwder" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).toBeNull();
  });

  it("treats corrupt state file as lastStep 0", () => {
    const dir = tmpDir();
    const transcriptPath = writeTranscript(dir, [assistantEntry({ input_tokens: 90_000 })]);
    const statePath = join(dir, "state");
    mkdirSync(statePath, { recursive: true });
    // Malformed JSON written directly at the real per-session state file path,
    // so readState's JSON.parse catch is actually exercised.
    writeFileSync(join(statePath, "s1.json"), "not-json");
    const msg = checkContextWatch(
      { transcriptPath, sessionId: "s1" },
      { ...DEFAULT_OPTS, statePath },
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("45%");
  });
});
