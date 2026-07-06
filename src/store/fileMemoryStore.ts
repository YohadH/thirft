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
    for (const file of findMemoryFiles(this.rootDir, this.maxDepth)) {
      const relPath = relative(this.rootDir, file).replace(/\\/g, "/");
      let text: string;
      let updatedAt: number;
      try {
        text = readFileSync(file, "utf8");
        updatedAt = Math.floor(statSync(file).mtimeMs);
      } catch {
        continue;
      }
      const chunks = chunkMarkdown(text, this.maxChunkChars);
      chunks.forEach((chunk, index) => {
        const id = fileRecordId(relPath, index);
        next.set(id, {
          id,
          scope: this.scope,
          text: chunk,
          tags: [
            "source:file",
            `path:${relPath}`,
            `file:${basename(relPath)}`,
            ...this.tags,
          ],
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

function findMemoryFiles(rootDir: string, maxDepth: number): string[] {
  const out: string[] = [];
  walk(rootDir, rootDir, 0, maxDepth, out);
  return out.sort();
}

function walk(dir: string, root: string, depth: number, maxDepth: number, out: string[]): void {
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
      walk(full, root, depth + 1, maxDepth, out);
    } else if (st.isFile() && isMemoryFile(relative(root, full))) {
      out.push(full);
    }
  }
}

function isMemoryFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  const base = basename(norm);
  if (ROOT_CONTEXT_BASENAMES.has(base)) return norm === base;
  if (norm === ".github/copilot-instructions.md") return true;
  if (/(^|\/)\.cursor\/rules\/.+\.(md|mdc)$/.test(norm)) return true;
  if (/(^|\/)\.windsurf\/rules\/.+\.(md|mdc)$/.test(norm)) return true;
  return false;
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
