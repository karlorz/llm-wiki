import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runFrontmatterFix } from "../../src/commands/frontmatter-fix.js";

function vault(): string {
  const dir = join(process.env.RUNNER_TEMP || "/tmp", `ff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "concepts"), { recursive: true });
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  return dir;
}

const FM = (tags: string[] = ["model"], sources: string[] = [], extra = "") =>
  `---\ntitle: Test\ncreated: 2026-05-06\nupdated: 2026-05-06\ntype: concept\ntags: [${tags.join(", ")}]\nsources: [${sources.map(s => `"${s}"`).join(", ")}]${extra}\n---\n`;

describe("frontmatter-fix", () => {
  let v: string;
  beforeEach(() => { v = vault(); });
  afterEach(() => { rmSync(v, { recursive: true, force: true }); });

  it("fixes missing created and updated fields", async () => {
    const body = `---\ntitle: Test\ntype: concept\ntags: [model]\nsources: []\n---\n\n## Overview\n\nContent.\n`;
    writeFileSync(join(v, "concepts", "no-dates.md"), body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[no-dates]]\n");
    const r = await runFrontmatterFix({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(34);
    if (r.result.ok) {
      expect(r.result.data.fixed).toContain("concepts/no-dates.md");
    }
  });

  it("fixes missing provenance field", async () => {
    const body = FM(["model"], [], "");
    writeFileSync(join(v, "concepts", "no-prov.md"), body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[no-prov]]\n");
    const r = await runFrontmatterFix({ vault: v, dryRun: false });
    if (r.result.ok) {
      expect(r.result.data.fixed).toContain("concepts/no-prov.md");
    }
  });

  it("removes orphan tags lines from body", async () => {
    const body = FM(["model"], [], '\nprovenance: research') + "\n## Overview\n\nContent.\ntags: [tooling]\n";
    writeFileSync(join(v, "concepts", "orphan.md"), body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[orphan]]\n");
    const r = await runFrontmatterFix({ vault: v, dryRun: false });
    if (r.result.ok) {
      expect(r.result.data.fixed).toContain("concepts/orphan.md");
      // Verify the orphan line was removed
      const { readFileSync } = await import("node:fs");
      const fixed = readFileSync(join(v, "concepts", "orphan.md"), "utf8");
      expect(fixed).not.toContain("tags: [tooling]");
    }
  });

  it("returns exit code 0 when no fixes needed", async () => {
    const body = FM(["model"], [], '\nprovenance: research') + "\n## Overview\n\nContent.\n";
    writeFileSync(join(v, "concepts", "clean.md"), body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[clean]]\n");
    const r = await runFrontmatterFix({ vault: v, dryRun: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fixed).toHaveLength(0);
      expect(r.result.data.unchanged).toBe(1);
    }
  });

  it("dry-run does not write files", async () => {
    const body = `---\ntitle: Test\ntype: concept\ntags: [model]\nsources: []\n---\n\n## Overview\n\nContent.\n`;
    writeFileSync(join(v, "concepts", "dry.md"), body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[dry]]\n");
    const before = await import("node:fs").then(m => m.readFileSync(join(v, "concepts", "dry.md"), "utf8"));
    const r = await runFrontmatterFix({ vault: v, dryRun: true });
    expect(r.exitCode).toBe(34);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("dry run");
    }
    const after = await import("node:fs").then(m => m.readFileSync(join(v, "concepts", "dry.md"), "utf8"));
    expect(after).toBe(before);
  });
});
