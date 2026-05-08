import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scanVault, readPage } from "../../src/utils/vault.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("scanVault", () => {
  it("rejects when SCHEMA.md missing", async () => {
    const r = await scanVault("/no/such/path");
    expect(r.ok).toBe(false);
  });

  it("returns markdown files grouped by layer", async () => {
    const r = await scanVault(VAULT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.typedKnowledge.map(p => p.relPath).sort()).toEqual([
        "concepts/alpha.md", "concepts/beta.md", "concepts/gamma.md"
      ]);
      expect(r.data.raw.map(p => p.relPath).sort()).toEqual([
        "raw/articles/x.md", "raw/articles/y.md"
      ]);
    }
  });

  it("populates workItems and compound from project directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# schema\n");
    const workDir = join(dir, "projects", "myproj", "work", "2026-01-01-task");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), "# spec\n");
    writeFileSync(join(workDir, "plan.md"), "# plan\n");
    const compDir = join(dir, "projects", "myproj", "compound");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "lesson.md"), "# lesson\n");
    const r = await scanVault(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.workItems.map(p => p.relPath).sort()).toEqual([
        "projects/myproj/work/2026-01-01-task/plan.md",
        "projects/myproj/work/2026-01-01-task/spec.md",
      ]);
      expect(r.data.compound.map(p => p.relPath)).toEqual(["projects/myproj/compound/lesson.md"]);
    }
  });

  it("readPage reads file content from VaultPage", async () => {
    const page = { absPath: join(VAULT, "concepts", "alpha.md"), relPath: "concepts/alpha.md" };
    const content = await readPage(page);
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });
});
