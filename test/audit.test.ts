import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditMemoryFiles, renderAudit } from "../src/audit.js";

// 40 chars -> 10 tokens with the chars/4 estimator, so token math stays exact.
const BLOCK = (c: string, n = 40) => c.repeat(n);

describe("auditMemoryFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "thrift-audit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("discovers the memory-file allow-list, including nested rules dirs", () => {
    writeFileSync(join(dir, "CLAUDE.md"), BLOCK("a", 400)); // 100 tok
    writeFileSync(join(dir, "AGENTS.md"), BLOCK("b", 80)); // 20 tok
    writeFileSync(join(dir, ".cursorrules"), BLOCK("c", 40)); // 10 tok
    mkdirSync(join(dir, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(dir, ".cursor", "rules", "api.mdc"), BLOCK("d", 40)); // 10 tok
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github", "copilot-instructions.md"), BLOCK("e", 40)); // 10 tok
    // Files that must NOT count:
    writeFileSync(join(dir, "README.md"), BLOCK("x", 4000));
    writeFileSync(join(dir, "notes.md"), BLOCK("y", 4000));

    const r = auditMemoryFiles(dir);
    const paths = r.files.map((f) => f.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain(".cursorrules");
    expect(paths).toContain(".cursor/rules/api.mdc");
    expect(paths).toContain(".github/copilot-instructions.md");
    expect(paths).not.toContain("README.md");
    expect(paths).not.toContain("notes.md");
    expect(r.totalTokens).toBe(150);
    // Sorted largest first.
    expect(r.files[0].path).toBe("CLAUDE.md");
  });

  it("skips dependency/build directories (a CLAUDE.md inside node_modules is not your memory)", () => {
    mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "some-pkg", "CLAUDE.md"), BLOCK("z", 4000));
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "AGENTS.md"), BLOCK("z", 4000));

    const r = auditMemoryFiles(dir);
    expect(r.files).toHaveLength(0);
    expect(r.totalTokens).toBe(0);
  });

  it("projects per-day/month usage and the saving vs the recall budget", () => {
    writeFileSync(join(dir, "CLAUDE.md"), BLOCK("a", 40_000)); // 10,000 tok
    const r = auditMemoryFiles(dir, { sessionsPerDay: 10, tokenBudget: 2_000, pricePerMTok: 15 });
    expect(r.totalPerSession).toBe(10_000);
    expect(r.tokensPerDay).toBe(100_000);
    expect(r.tokensPerMonth).toBe(3_000_000);
    expect(r.monthlyCostUsd).toBeCloseTo(45, 5); // 3M / 1M * $15
    expect(r.projectedSavingPct).toBeCloseTo(0.8, 5); // 1 - 2000/10000
  });

  it("reports zero saving when memory already fits the budget", () => {
    writeFileSync(join(dir, "CLAUDE.md"), BLOCK("a", 400)); // 100 tok
    const r = auditMemoryFiles(dir, { tokenBudget: 2_000 });
    expect(r.projectedSavingPct).toBe(0);
    const lines = renderAudit(r).join("\n");
    expect(lines).toContain("already fits");
  });

  it("includes the user-global CLAUDE.md when a homeDir is provided", () => {
    const home = mkdtempSync(join(tmpdir(), "thrift-home-"));
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), BLOCK("g", 200)); // 50 tok
      writeFileSync(join(dir, "CLAUDE.md"), BLOCK("a", 200)); // 50 tok

      const r = auditMemoryFiles(dir, { homeDir: home });
      expect(r.globalFiles).toHaveLength(1);
      expect(r.totalTokens).toBe(50); // repo only
      expect(r.totalPerSession).toBe(100); // repo + global
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("renders a friendly empty state and exit-worthy output for a repo with no memory files", () => {
    const r = auditMemoryFiles(dir);
    const lines = renderAudit(r);
    expect(lines.join("\n")).toContain("No agent memory files found");
  });

  it("renders the table with totals and projection lines", () => {
    writeFileSync(join(dir, "CLAUDE.md"), BLOCK("a", 40_000)); // 10,000 tok
    const text = renderAudit(auditMemoryFiles(dir)).join("\n");
    expect(text).toContain("CLAUDE.md");
    expect(text).toContain("TOTAL reloaded per session");
    expect(text).toContain("10,000");
    expect(text).toContain("sessions/day");
    expect(text).toContain("projected saving ~80%");
    expect(text).toContain("an assumption"); // the $ line is always labeled
  });
});
