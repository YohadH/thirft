/**
 * `thrift-memory audit` — the zero-commitment waste report.
 *
 * Scans a repository for the agent memory / instruction files that coding
 * agents reload at every session start (CLAUDE.md, AGENTS.md, .cursorrules,
 * copilot-instructions.md, …), estimates their token cost with the same
 * estimator the rest of Thrift uses, and projects what that reload costs per
 * day/month — plus what a hard recall budget would save.
 *
 * Pure library: `auditMemoryFiles` only reads the filesystem and returns
 * structured data; `renderAudit` turns it into printable lines. The bin wires
 * them to argv/stdout. No wall-clock reads, no writes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { estimateTokens } from "./tokens.js";

/** One discovered memory/instruction file and its estimated token cost. */
export interface AuditFile {
  /** Path relative to the audited root (repo files) or absolute (global files). */
  path: string;
  tokens: number;
}

export interface AuditOptions {
  /** Agent sessions per day used for the projection. Default 10. */
  sessionsPerDay?: number;
  /** The thrift recall budget to project savings against. Default 2000. */
  tokenBudget?: number;
  /** USD per million input tokens for the illustrative cost line. Default 15. */
  pricePerMTok?: number;
  /** Home directory to check for user-global memory files (injectable for tests). */
  homeDir?: string;
  /** Max directory depth to walk. Default 6. */
  maxDepth?: number;
}

export interface AuditResult {
  root: string;
  /** Repo-level memory files, sorted by token cost (largest first). */
  files: AuditFile[];
  /** Sum of repo-level file tokens. */
  totalTokens: number;
  /** User-global memory files (e.g. ~/.claude/CLAUDE.md) — also reloaded every session. */
  globalFiles: AuditFile[];
  /** Repo + global: what a session actually reloads. */
  totalPerSession: number;
  sessionsPerDay: number;
  tokensPerDay: number;
  tokensPerMonth: number;
  /** Illustrative cost at `pricePerMTok` — an assumption, always labeled as such. */
  monthlyCostUsd: number;
  pricePerMTok: number;
  tokenBudget: number;
  /** 0..1 share of per-session memory tokens a hard recall budget would avoid. */
  projectedSavingPct: number;
}

/** Directories never worth descending into (dependency/build output, VCS). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "coverage",
]);

/**
 * Root-context basenames (lower-cased): the memory/instruction files an agent
 * reloads at EVERY session start — but only the copy at the repository root.
 *
 * A nested copy (e.g. `packages/api/AGENTS.md`, `third_party/foo/CLAUDE.md`) is
 * NOT a per-session reload: agents load subtree memory on demand only when they
 * work in that subtree, and a vendored copy under a dependency is never the
 * agent's own context at all. Counting nested/vendored copies as per-session
 * reloads inflates the waste projection — so these are matched at the root only.
 */
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

/**
 * Is this relative path an agent memory/instruction file reloaded per session?
 *
 * Root-context files count only at the root. Rules-directory / config files
 * (`.cursor/rules/`, `.windsurf/rules/`, `.github/copilot-instructions.md`)
 * live at fixed canonical locations and are matched wherever those exact paths
 * occur relative to the root.
 */
function isMemoryFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").toLowerCase();
  const base = basename(norm);
  // Root-context files are a per-session reload ONLY at the repo root. A nested
  // or vendored copy (basename === full path is false → it sits in a subdir) is
  // on-demand/foreign context, not a per-session reload — do not count it.
  if (ROOT_CONTEXT_BASENAMES.has(base)) return norm === base;
  if (norm === ".github/copilot-instructions.md") return true;
  // Rules directories: every .md/.mdc under them is auto-loaded.
  if (/(^|\/)\.cursor\/rules\/.+\.(md|mdc)$/.test(norm)) return true;
  if (/(^|\/)\.windsurf\/rules\/.+\.(md|mdc)$/.test(norm)) return true;
  return false;
}

function walk(dir: string, root: string, depth: number, maxDepth: number, out: string[]): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable dir — skip, an audit should never crash on permissions
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

function fileTokens(path: string): number {
  try {
    return estimateTokens(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
}

/** Scan `rootDir` (and the user's global memory) and compute the waste projection. */
export function auditMemoryFiles(rootDir: string, opts: AuditOptions = {}): AuditResult {
  const sessionsPerDay = opts.sessionsPerDay ?? 10;
  const tokenBudget = opts.tokenBudget ?? 2_000;
  const pricePerMTok = opts.pricePerMTok ?? 15;
  const maxDepth = opts.maxDepth ?? 6;

  const found: string[] = [];
  walk(rootDir, rootDir, 0, maxDepth, found);

  const files: AuditFile[] = found
    .map((f) => ({ path: relative(rootDir, f).replace(/\\/g, "/"), tokens: fileTokens(f) }))
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  const totalTokens = files.reduce((t, f) => t + f.tokens, 0);

  const globalFiles: AuditFile[] = [];
  if (opts.homeDir) {
    const globalClaude = join(opts.homeDir, ".claude", "CLAUDE.md");
    if (existsSync(globalClaude)) {
      globalFiles.push({ path: globalClaude.replace(/\\/g, "/"), tokens: fileTokens(globalClaude) });
    }
  }
  const globalTokens = globalFiles.reduce((t, f) => t + f.tokens, 0);

  const totalPerSession = totalTokens + globalTokens;
  const tokensPerDay = totalPerSession * sessionsPerDay;
  const tokensPerMonth = tokensPerDay * 30;
  const monthlyCostUsd = (tokensPerMonth / 1_000_000) * pricePerMTok;
  const projectedSavingPct =
    totalPerSession > 0 ? 1 - Math.min(tokenBudget, totalPerSession) / totalPerSession : 0;

  return {
    root: rootDir,
    files,
    totalTokens,
    globalFiles,
    totalPerSession,
    sessionsPerDay,
    tokensPerDay,
    tokensPerMonth,
    monthlyCostUsd,
    pricePerMTok,
    tokenBudget,
    projectedSavingPct,
  };
}

const n = (v: number): string => v.toLocaleString("en-US");

/** Render the audit as printable lines (kept pure so tests can assert on it). */
export function renderAudit(r: AuditResult): string[] {
  const out: string[] = [];
  out.push(`Thrift Memory audit — ${r.root}`);
  out.push("");

  if (r.files.length === 0 && r.globalFiles.length === 0) {
    out.push("No agent memory files found (CLAUDE.md, AGENTS.md, MEMORY.md, .cursorrules,");
    out.push(".cursor/rules/, .github/copilot-instructions.md, …).");
    out.push("");
    out.push("If your agents load context another way, point the audit at it: --path=<dir>");
    return out;
  }

  const width = Math.max(20, ...r.files.map((f) => f.path.length)) + 2;
  out.push("  " + "File".padEnd(width) + "Tokens".padStart(8));
  for (const f of r.files) {
    out.push("  " + f.path.padEnd(width) + n(f.tokens).padStart(8));
  }
  for (const g of r.globalFiles) {
    out.push("  " + `${g.path} (user-global)`.padEnd(width) + n(g.tokens).padStart(8));
  }
  out.push("  " + "TOTAL reloaded per session".padEnd(width) + n(r.totalPerSession).padStart(8));
  out.push("");
  out.push(
    `At ${r.sessionsPerDay} sessions/day (--sessions): ~${n(r.tokensPerDay)} tokens/day, ~${n(r.tokensPerMonth)}/month`,
  );
  out.push(
    `≈ $${r.monthlyCostUsd.toFixed(2)}/month at $${r.pricePerMTok}/M input tokens (an assumption — adjust: --price-per-mtok)`,
  );
  out.push("");
  if (r.totalPerSession > r.tokenBudget) {
    out.push(
      `With recall capped at ${n(r.tokenBudget)} tokens/session (--budget): projected saving ~${Math.round(r.projectedSavingPct * 100)}%`,
    );
  } else {
    out.push(
      `Your per-session memory load already fits a ${n(r.tokenBudget)}-token budget — nice. Thrift still adds receipts + scoped recall.`,
    );
  }
  out.push("");
  out.push("Try it:   npx thrift-memory        (MCP server; see README for client config)");
  out.push("Claude Code: /plugin marketplace add YohadH/thrift-memory");
  return out;
}
