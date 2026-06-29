#!/usr/bin/env node
/**
 * Import markdown memories into a Thrift JSONL store.
 *
 * Examples:
 *   node scripts/import-memories.mjs --source=./memory --scope=org --dry-run
 *   node scripts/import-memories.mjs --source=./memory --scope=agent --store-path=~/.thrift/memories.jsonl
 *
 * Org mode:
 *   imports every .md file under --source as an org-scoped memory.
 *
 * Agent mode:
 *   expects files shaped like <source>/<project>/<agent>.md and imports each
 *   file as agent-scoped memory with agentId=<agent> and tag project:<project>.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return argv.includes(`--${name}`);
}

const sourcePath = resolve(flag("source", "./memory"));
const scope = flag("scope", "org");
const storePath = expandHome(flag("store-path", join(homedir(), ".thrift", "memories.jsonl")));
const dryRun = hasFlag("dry-run");
const clear = hasFlag("clear");
const extraTags = argv
  .filter((a) => a.startsWith("--tag="))
  .map((a) => a.slice("--tag=".length))
  .filter(Boolean);

if (scope !== "org" && scope !== "agent") {
  fail(`--scope must be "org" or "agent", got "${scope}"`);
}

const CHARS_PER_TOKEN = 4;
const CHUNK_CHARS = 4000;

function estimateTokens(text) {
  return text ? Math.ceil(text.length / CHARS_PER_TOKEN) : 0;
}

function expandHome(path) {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(2))
    : path;
}

function fail(message) {
  console.error(`[import-memories] ${message}`);
  process.exit(1);
}

function ensureDir(path) {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) {
    out.push(text.slice(i, i + CHUNK_CHARS));
  }
  return out.length ? out : [""];
}

function appendRecord(record) {
  if (dryRun) return;
  ensureDir(storePath);
  appendFileSync(storePath, JSON.stringify({ op: "put", record }) + "\n");
}

function makeRecord(input, now) {
  return {
    id: randomUUID(),
    ...input,
    pinned: false,
    disabled: false,
    tokens: estimateTokens(input.text),
    createdAt: now,
    updatedAt: now,
  };
}

function importOrg(files, now) {
  let records = 0;
  let tokens = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(sourcePath, file).replaceAll("\\", "/");
    const record = makeRecord({
      scope: "org",
      text,
      tags: ["import:markdown", `path:${rel}`, ...extraTags],
    }, now);
    appendRecord(record);
    records += 1;
    tokens += record.tokens;
    console.log(`[org] ${rel} (${record.tokens} tok)`);
  }
  return { records, tokens };
}

function importAgent(files, now) {
  let records = 0;
  let tokens = 0;
  for (const file of files) {
    const rel = relative(sourcePath, file).replaceAll("\\", "/");
    const parts = rel.split("/");
    if (parts.length < 2) {
      console.log(`[skip] ${rel} (agent scope expects <project>/<agent>.md)`);
      continue;
    }
    const project = parts[0];
    const agentId = basename(parts.at(-1), ".md");
    const text = readFileSync(file, "utf8");
    const partsForFile = chunks(text);
    for (let i = 0; i < partsForFile.length; i++) {
      const record = makeRecord({
        scope: "agent",
        agentId,
        text: partsForFile[i],
        tags: ["import:markdown", "agent-memory", `project:${project}`, `path:${rel}`, ...extraTags],
      }, now);
      appendRecord(record);
      records += 1;
      tokens += record.tokens;
    }
    console.log(`[agent] ${rel} -> ${agentId} (${partsForFile.length} chunk(s), ${estimateTokens(text)} tok)`);
  }
  return { records, tokens };
}

function main() {
  if (!existsSync(sourcePath)) {
    fail(`source directory not found: ${sourcePath}`);
  }
  if (!dryRun && clear) {
    ensureDir(storePath);
    writeFileSync(storePath, "");
  }

  const now = Date.now();
  const files = walkMarkdown(sourcePath);
  console.log("Thrift Memory Import");
  console.log(`source: ${sourcePath}`);
  console.log(`scope:  ${scope}`);
  console.log(`store:  ${storePath}`);
  console.log(`mode:   ${dryRun ? "dry-run" : "write"}`);
  console.log("");

  const result = scope === "org" ? importOrg(files, now) : importAgent(files, now);
  console.log("");
  console.log(`imported records: ${result.records}`);
  console.log(`imported tokens:  ${result.tokens.toLocaleString()}`);
  if (dryRun) console.log("dry run only: no writes performed");
}

main();
