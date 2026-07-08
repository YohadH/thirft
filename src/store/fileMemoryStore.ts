/**
 * FileMemoryStore reads the repo's existing agent memory files as read-only
 * memory records. It is the "source file" half of the hybrid model:
 * MEMORY.md/AGENTS.md/etc. remain editable by humans, while JsonlStore remains
 * the writable overlay for `remember`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { estimateTokens } from "../tokens.js";
import type { MemoryInput, MemoryRecord, Scope } from "../types.js";
import type { MemoryStore } from "./index.js";

export interface FileMemoryStoreOptions {
  /** Repository/root directory to scan for memory files. Defaults to process.cwd(). */
  rootDir?: string;
  /** Scope assigned to file-backed records. Defaults to org. */
  scope?: Scope;
  /** Extra tags to attach to every file-backed record. */
  tags?: string[];
  /** Max directory depth to scan. Defaults to 6. */
  maxDepth?: number;
  /** Maximum characters per generated memory chunk. Defaults to 4000. */
  maxChunkChars?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_CHUNK_CHARS = 4_000;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "coverage",
]);

const ROOT_CONTEXT_BASENAMES = new Set([
  "claude.md",
  "claude.local.md",
  "memory.md",
  "agents.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
]);

const RESERVED_AGENT_MEMORY_DIRS = new Set([
  "advice",
  "archive",
  "feed",
  "reports",
  "shared",
]);

interface SourceFile {
  path: string;
  scope: Scope;
  agentId?: string;
  tags: string[];
}

export class FileMemoryStore implements MemoryStore {
  private readonly rootDir: string;
  private readonly scope: Scope;
  private readonly tags: string[];
  private readonly maxDepth: number;
  private readonly maxChunkChars: number;
  private records = new Map<string, MemoryRecord>();

  constructor(opts: FileMemoryStoreOptions = {}) {
    this.rootDir = resolve(opts.rootDir ?? process.cwd());
    this.scope = opts.scope ?? "org";
    this.tags = opts.tags ?? [];
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxChunkChars = opts.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  }

  add(_input: MemoryInput, _now: number): MemoryRecord {
    throw new Error("FileMemoryStore is read-only; write memories to JsonlStore");
  }

  get(id: string): MemoryRecord | undefined {
    this.refresh();
    return this.records.get(id);
  }

  update(): MemoryRecord | undefined {
    return undefined;
  }

  remove(): boolean {
    return false;
  }

  list(filter?: { scope?: Scope; agentId?: string; sessionId?: string }): MemoryRecord[] {
    this.refresh();
    const out: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (filter?.scope && record.scope !== filter.scope) continue;
      if (filter?.agentId && record.agentId !== filter.agentId) continue;
      if (filter?.sessionId && record.sessionId !== filter.sessionId) continue;
      out.push(record);
    }
    return out;
  }

  /** Re-scan source files. Called on every read so file edits are visible live. */
  refresh(): void {
    const next = new Map<string, MemoryRecord>();
    for (const source of findMemoryFiles(this.rootDir, this.maxDepth, this.scope, this.tags)) {
      const relPath = relative(this.rootDir, source.path).replace(/\\/g, "/");
      let text: string;
      let updatedAt: number;
      try {
        text = readFileSync(source.path, "utf8");
        updatedAt = Math.floor(statSync(source.path).mtimeMs);
      } catch {
        continue;
      }
      const chunks = chunkMarkdown(text, this.maxChunkChars);
      chunks.forEach((chunk, index) => {
        const id = fileRecordId(relPath, index);
        next.set(id, {
          id,
          scope: source.scope,
          agentId: source.agentId,
          text: chunk,
          tags: source.tags,
          pinned: false,
          disabled: false,
          tokens: estimateTokens(chunk),
          createdAt: updatedAt,
          updatedAt,
        });
      });
    }
    this.records = next;
  }
}

function findMemoryFiles(
  rootDir: string,
  maxDepth: number,
  defaultScope: Scope,
  extraTags: string[],
): SourceFile[] {
  const out: SourceFile[] = [];
  walk(rootDir, rootDir, 0, maxDepth, defaultScope, extraTags, out);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function walk(
  dir: string,
  root: string,
  depth: number,
  maxDepth: number,
  defaultScope: Scope,
  extraTags: string[],
  out: SourceFile[],
): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry.toLowerCase())) continue;
      walk(full, root, depth + 1, maxDepth, defaultScope, extraTags, out);
    } else if (st.isFile()) {
      const relPath = relative(root, full);
      const source = classifyMemoryFile(relPath, full, defaultScope, extraTags);
      if (source) out.push(source);
    }
  }
}

function classifyMemoryFile(
  relPath: string,
  fullPath: string,
  defaultScope: Scope,
  extraTags: string[],
): SourceFile | undefined {
  // `norm` is lowercased ONLY for case-insensitive *path pattern* matching
  // (MEMORY.md vs memory.md, .Cursor/rules, reserved-dir names). The agentId
  // itself must preserve the on-disk directory casing, otherwise a mixed-case
  // dir (e.g. memory/MyAgent/) would be stored as "myagent" and never match the
  // caller's real agentId at recall time (unmatchable recall), or collide with a
  // sibling memory/myagent/ dir (cross-agent bleed). See BUG-THRFT. The writable
  // JsonlStore already preserves agentId casing verbatim; this keeps the file
  // store consistent with it.
  const normDir = relPath.replace(/\\/g, "/");
  const norm = normDir.toLowerCase();
  const base = basename(norm);
  const agentMatch = /^memory\/([^/]+)\/([^/]+\.(md|mdc))$/i.exec(normDir);
  if (agentMatch && !RESERVED_AGENT_MEMORY_DIRS.has(agentMatch[1].toLowerCase())) {
    const agentId = agentMatch[1]; // on-disk casing preserved
    return {
      path: fullPath,
      scope: "agent",
      agentId,
      tags: fileTags(relPath, extraTags, [`agent:${agentId}`]),
    };
  }
  if (ROOT_CONTEXT_BASENAMES.has(base) && norm === base) {
    return { path: fullPath, scope: defaultScope, tags: fileTags(relPath, extraTags) };
  }
  if (norm === ".github/copilot-instructions.md") {
    return { path: fullPath, scope: defaultScope, tags: fileTags(relPath, extraTags) };
  }
  if (/(^|\/)\.cursor\/rules\/.+\.(md|mdc)$/.test(norm)) {
    return { path: fullPath, scope: defaultScope, tags: fileTags(relPath, extraTags) };
  }
  if (/(^|\/)\.windsurf\/rules\/.+\.(md|mdc)$/.test(norm)) {
    return { path: fullPath, scope: defaultScope, tags: fileTags(relPath, extraTags) };
  }
  return undefined;
}

function fileTags(relPath: string, extraTags: string[], scopedTags: string[] = []): string[] {
  const normalized = relPath.replace(/\\/g, "/");
  return [
    "source:file",
    `path:${normalized}`,
    `file:${basename(normalized)}`,
    ...scopedTags,
    ...extraTags,
  ];
}

function fileRecordId(relPath: string, index: number): string {
  const hash = createHash("sha256").update(`${relPath}\0${index}`).digest("hex").slice(0, 16);
  return `file:${hash}`;
}

function chunkMarkdown(text: string, maxChunkChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const sections = splitByHeadings(normalized);
  const chunks: string[] = [];
  for (const section of sections) chunks.push(...packText(section, maxChunkChars));
  return chunks;
}

function splitByHeadings(text: string): string[] {
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s+/.test(line) && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current);
  return sections.map((lines) => lines.join("\n").trim()).filter(Boolean);
}

function packText(text: string, maxChunkChars: number): string[] {
  if (text.length <= maxChunkChars) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardWrap(paragraph, maxChunkChars));
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChunkChars) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hardWrap(text: string, maxChunkChars: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChunkChars) {
    chunks.push(text.slice(i, i + maxChunkChars));
  }
  return chunks;
}
