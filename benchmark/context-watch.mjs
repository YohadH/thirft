#!/usr/bin/env node
/**
 * context-watch benchmark: demonstrates the measurable token savings of the
 * context-watch hook (save durable facts at 20%-of-window steps -> compact ->
 * reload only a budgeted slice) versus the "no context-watch" baseline (facts
 * are lost at compaction, so the next task must reload the full memory file).
 *
 * Synthetic simulation: fixture facts + fixed window sizes, deterministic and
 * reproducible. It does not run a real Claude session; see the methodology
 * note printed below. Run `npm run build` first so dist/ exists.
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlStore, ScopedRetriever } from "../dist/index.js";
import { computeStep } from "../dist/contextWatch.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Same defaults the context-watch hook uses (src/mcp/bin.ts: step-pct 20, min 80,000 tokens, max 50% of window). */
const STEP_OPTS = { stepPct: 20, minStepTokens: 80_000, maxStepPct: 50 };
/** Same default recall budget the SessionStart hook uses (plugins/thrift-memory/hooks/hooks.json --budget=1500). */
const RECALL_TOKEN_BUDGET = 1500;
/** Simulated windows: the default 200k window, and a 1M window where multiple 20% steps fire. */
const WINDOWS = [
  { label: "default window", windowTokens: 200_000 },
  { label: "1M-class window", windowTokens: 1_000_000 },
];

if (!existsSync(join(root, "dist", "index.js")) || !existsSync(join(root, "dist", "contextWatch.js"))) {
  console.error("dist/ not found or incomplete. Run `npm run build` first.");
  process.exit(1);
}

const storePath = join(root, "benchmark", "fixtures", "context-watch-memories.jsonl");
const store = new JsonlStore({ path: storePath });
const retriever = new ScopedRetriever();

// The recall a task performs post-compaction, WITH context-watch: facts were
// saved incrementally at each step, so this is a normal budgeted recall.
const recall = retriever.recall(store, { agentId: "context-watch-bench", tokenBudget: RECALL_TOKEN_BUDGET });

console.log("context-watch benchmark");
console.log("========================");
console.log(`store:          ${relativeToRoot(storePath)}`);
console.log(`recall budget:  ${fmt(RECALL_TOKEN_BUDGET)} tokens (SessionStart hook default)`);
console.log(`step options:   stepPct=${STEP_OPTS.stepPct} minStepTokens=${fmt(STEP_OPTS.minStepTokens)} maxStepPct=${STEP_OPTS.maxStepPct}`);
console.log("");
console.log("Per-compaction recall (with context-watch, budgeted slice):");
printReceipt("  recall", recall);
console.log("");

let grandBaseline = 0;
let grandInjected = 0;

for (const { label, windowTokens } of WINDOWS) {
  const step = computeStep(windowTokens, STEP_OPTS);
  const compactions = Math.floor(windowTokens / step);
  const stepPctOfWindow = Math.round((100 * step) / windowTokens);

  // WITHOUT context-watch: facts are lost at each compaction, so the next
  // task reloads the full durable-facts corpus every time (baseline tokens).
  const withoutTotal = compactions * recall.baselineTokens;
  // WITH context-watch: facts were saved before compaction, so each
  // post-compaction task only injects the budgeted slice.
  const withTotal = compactions * recall.injectedTokens;
  const saved = withoutTotal - withTotal;
  const ratio = withoutTotal === 0 ? 0 : saved / withoutTotal;

  grandBaseline += withoutTotal;
  grandInjected += withTotal;

  console.log(`${label} (${fmt(windowTokens)} tokens):`);
  console.log(`  step size:     ${fmt(step)} tokens (${stepPctOfWindow}% of window)`);
  console.log(`  compactions:   ${compactions} (steps that fire before the window fills)`);
  console.log(`  without context-watch: ${fmt(withoutTotal)} tokens reloaded (full corpus x ${compactions})`);
  console.log(`  with context-watch:    ${fmt(withTotal)} tokens injected (budgeted slice x ${compactions})`);
  console.log(`  saved:                 ${fmt(saved)} tokens (${(ratio * 100).toFixed(1)}%)`);
  console.log("");
}

const grandSaved = grandBaseline - grandInjected;
const grandRatio = grandBaseline === 0 ? 0 : grandSaved / grandBaseline;
console.log("totals across all simulated windows:");
console.log(`  baseline: ${fmt(grandBaseline)} tokens`);
console.log(`  injected: ${fmt(grandInjected)} tokens`);
console.log(`  saved:    ${fmt(grandSaved)} tokens (${(grandRatio * 100).toFixed(1)}%)`);
console.log("");
console.log("Methodology note: this is a synthetic simulation. Compaction counts come from");
console.log("computeStep() (the same clamp the context-watch hook uses); the fixture facts");
console.log("corpus is fixed and checked in, not a real long-running Claude session.");

function printReceipt(label, receipt) {
  const ratio = receipt.baselineTokens === 0 ? 0 : receipt.savedTokens / receipt.baselineTokens;
  console.log(`${label}:`);
  console.log(`  baseline: ${fmt(receipt.baselineTokens)} tokens`);
  console.log(`  injected: ${fmt(receipt.injectedTokens)} tokens`);
  console.log(`  saved:    ${fmt(receipt.savedTokens)} tokens (${(ratio * 100).toFixed(1)}%)`);
}

function fmt(value) {
  return new Intl.NumberFormat().format(value);
}

function relativeToRoot(path) {
  return relative(root, path).replaceAll("\\", "/");
}
