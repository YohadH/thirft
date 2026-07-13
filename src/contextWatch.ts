/**
 * `thrift-memory context-watch` — the compaction early-warning for hooks.
 *
 * A Claude Code UserPromptSubmit hook feeds this the transcript path + session
 * id (as hook JSON on stdin). It estimates how full the model's context window
 * is and, when usage crosses a new percentage-step threshold, emits hook
 * output instructing the agent to save durable memories before compaction.
 *
 * Contract: this must never break the prompt flow. Any read/parse failure —
 * missing transcript, corrupt state, malformed input — resolves to "no
 * output", never a thrown error or non-zero exit from the caller's side.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default window size (tokens) for models not recognized as 1M-class. */
const DEFAULT_WINDOW_TOKENS = 200_000;
/** Window size (tokens) for models advertising a 1M-token context. */
const LARGE_WINDOW_TOKENS = 1_000_000;
/** Fallback chars-per-token ratio when transcript usage can't be read. */
const CHARS_PER_TOKEN_FALLBACK = 4;
/** Bounded tail-read size: files at or below this are read whole; larger ones are tailed. */
const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export interface StepOptions {
  /** Percentage of the window each step represents, before clamping (e.g. 20). */
  stepPct: number;
  /** Minimum step size in tokens (floor). */
  minStepTokens: number;
  /** Maximum step size as a percentage of the window (ceiling). */
  maxStepPct: number;
}

export interface TranscriptTail {
  usageTokens?: number;
  model?: string;
}

export interface CheckContextWatchInput {
  transcriptPath: string;
  sessionId: string;
}

export interface CheckContextWatchOptions extends StepOptions {
  /** Directory where per-session state files live. */
  statePath: string;
  /** Explicit window override (tokens); wins over model inference. */
  windowTokens?: number;
}

interface WatchState {
  lastStep: number;
}

/** step = clamp(stepPct% of window, minStepTokens, maxStepPct% of window). */
export function computeStep(windowTokens: number, opts: StepOptions): number {
  const desired = (opts.stepPct / 100) * windowTokens;
  const max = (opts.maxStepPct / 100) * windowTokens;
  return Math.min(Math.max(desired, opts.minStepTokens), max);
}

/** Model id → context window size. `[1m]` / `1m`-suffixed models get the large window. */
export function windowForModel(model?: string): number {
  if (model && /(?:\[1m\]|[\-_]1m$)/i.test(model)) return LARGE_WINDOW_TOKENS;
  return DEFAULT_WINDOW_TOKENS;
}

/**
 * Scans a transcript JSONL file from the end for the last assistant entry
 * carrying `message.usage`. Falls back to `fileSize / 4` when no usable
 * entry is found (or the file can't be parsed at all).
 */
export function readTranscriptTail(transcriptPath: string): TranscriptTail {
  let content: string;
  let fileSize: number;
  try {
    fileSize = statSync(transcriptPath).size;
    if (fileSize <= TAIL_READ_CHUNK_BYTES) {
      content = readFileSync(transcriptPath, "utf8");
    } else {
      content = readTailBytes(transcriptPath, fileSize, TAIL_READ_CHUNK_BYTES);
    }
  } catch {
    return {};
  }

  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          model?: string;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        };
      };
      if (entry.type === "assistant" && entry.message?.usage) {
        const u = entry.message.usage;
        const usageTokens =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        return { usageTokens, model: entry.message.model };
      }
    } catch {
      // Not JSON (or shape we don't expect) — keep scanning backwards.
      continue;
    }
  }

  // No usable assistant usage entry anywhere in the transcript.
  return { usageTokens: Math.floor(fileSize / CHARS_PER_TOKEN_FALLBACK) };
}

/**
 * Reads only the last `chunkBytes` of a file and discards a possibly-truncated
 * first line (no leading newline, or a line cut mid-JSON-object).
 */
function readTailBytes(path: string, fileSize: number, chunkBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(chunkBytes);
    const position = fileSize - chunkBytes;
    const bytesRead = readSync(fd, buffer, 0, chunkBytes, position);
    const chunk = buffer.toString("utf8", 0, bytesRead);
    const firstNewline = chunk.indexOf("\n");
    return firstNewline === -1 ? "" : chunk.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

/** Safe session id characters — Claude Code supplies a UUID in practice. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function statePathFor(statePath: string, sessionId: string): string {
  return join(statePath, `${sessionId}.json`);
}

function readState(statePath: string, sessionId: string): WatchState {
  try {
    const raw = readFileSync(statePathFor(statePath, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<WatchState>;
    const lastStep = typeof parsed.lastStep === "number" ? parsed.lastStep : 0;
    return { lastStep };
  } catch {
    return { lastStep: 0 };
  }
}

function writeState(statePath: string, sessionId: string, state: WatchState): void {
  try {
    mkdirSync(statePath, { recursive: true });
    writeFileSync(statePathFor(statePath, sessionId), JSON.stringify(state));
  } catch {
    // State persistence is best-effort — a hook must never break on this.
  }
}

/**
 * Orchestrates a single context-watch check: reads the transcript tail,
 * infers window + step size, and fires (returning hook JSON as a string)
 * exactly once per crossed step per session.
 */
export function checkContextWatch(
  input: CheckContextWatchInput,
  opts: CheckContextWatchOptions,
): string | null {
  if (!SAFE_SESSION_ID.test(input.sessionId)) return null;
  if (!existsSync(input.transcriptPath)) return null;

  const tail = readTranscriptTail(input.transcriptPath);
  const usage = tail.usageTokens ?? 0;
  const window = opts.windowTokens ?? windowForModel(tail.model);
  const step = computeStep(window, opts);
  if (!(step > 0)) return null;

  const stepIndex = Math.floor(usage / step);
  if (stepIndex < 1) return null;

  const state = readState(opts.statePath, input.sessionId);
  if (stepIndex <= state.lastStep) return null;

  writeState(opts.statePath, input.sessionId, { lastStep: stepIndex });

  const pct = Math.round((100 * usage) / window);
  const sessionTag = `session:${input.sessionId}`;
  const additionalContext =
    `Context usage crossed ${pct}% of the model's window — before saving, call ` +
    `search_memory with tag "${sessionTag}" to see what you already stored ` +
    `this session, then store only new durable facts via the Thrift remember ` +
    `tool (tag them "${sessionTag}" too), and suggest the user run /compact.`;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
}
