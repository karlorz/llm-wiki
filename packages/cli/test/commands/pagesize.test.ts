import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPagesize } from "../../src/commands/pagesize.js";

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

function v(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

describe("runPagesize", () => {
  it("under threshold -> exit 0", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "small.md"), FM + "line\n".repeat(50));
    const r = await runPagesize({ vault: dir, lines: 200 });
    expect(r.exitCode).toBe(0);
  });

  it("over threshold -> exit 20 with body line count", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "big.md"), FM + "line\n".repeat(250));
    const r = await runPagesize({ vault: dir, lines: 200 });
    expect(r.exitCode).toBe(20);
    if (r.result.ok) {
      expect(r.result.data.oversized.length).toBe(1);
      expect(r.result.data.oversized[0].lines).toBeGreaterThan(200);
    }
  });

  it("custom --lines threshold respected", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "p.md"), FM + "line\n".repeat(80));
    const r = await runPagesize({ vault: dir, lines: 50 });
    expect(r.exitCode).toBe(20);
  });
});
