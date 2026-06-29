#!/usr/bin/env node
/**
 * Synthetic benchmark for Thrift's public repo.
 *
 * This intentionally uses small fixture files checked into benchmark/fixtures.
 * It proves the measurement pipeline works without exposing any private fleet
 * data. Run `npm run build` first so dist/ exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlStore, ScopedRetriever } from "../dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function flag(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const storePath = flag("store", join(root, "benchmark", "fixtures", "memories.jsonl"));
const meterPath = flag("meter", join(root, "benchmark", "fixtures", "meter.jsonl"));
const agentId = flag("agent", "developer");
const task = flag("task", "fix the TypeScript build and update dashboard tests");
const tokenBudget = Number(flag("budget", "80"));

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/index.js not found. Run `npm run build` first.");
  process.exit(1);
}

if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
  console.error("--budget must be a non-negative number");
  process.exit(1);
}

const store = new JsonlStore({ path: storePath });
const retriever = new ScopedRetriever();
const recall = retriever.recall(store, { agentId, task, tokenBudget });
const meterEvents = readMeterEvents(meterPath);
const fleet = rollup(meterEvents);

console.log("Thrift synthetic benchmark");
console.log("==========================");
console.log(`store:  ${relativeToRoot(storePath)}`);
console.log(`meter:  ${relativeToRoot(meterPath)}`);
console.log(`agent:  ${agentId}`);
console.log(`budget: ${tokenBudget} tokens`);
console.log("");
printReceipt("single recall", recall);
console.log("");
printReceipt("fixture meter rollup", fleet);
console.log("");
console.log("Selected memories:");
for (const memory of recall.memories) {
  console.log(`- [${memory.scope}${memory.agentId ? `:${memory.agentId}` : ""}] ${memory.text.slice(0, 90).replace(/\s+/g, " ")} (${memory.tokens} tok)`);
}

function readMeterEvents(path) {
  if (!existsSync(path)) return [];
  const events = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (
      typeof row.agentId === "string" &&
      typeof row.injectedTokens === "number" &&
      typeof row.baselineTokens === "number"
    ) {
      events.push(row);
    }
  }
  return events;
}

function rollup(events) {
  let injectedTokens = 0;
  let baselineTokens = 0;
  for (const event of events) {
    injectedTokens += event.injectedTokens;
    baselineTokens += event.baselineTokens;
  }
  return {
    memories: [],
    injectedTokens,
    baselineTokens,
    savedTokens: baselineTokens - injectedTokens,
  };
}

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
