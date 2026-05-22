import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeWritePage } from "../../src/utils/safe-write.js";

function tmpDir(): string {
  const d = join(process.env.RUNNER_TEMP || "/tmp", `sw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const FM = (extra = "") => `---\ntitle: Test\ntype: concept\n${extra}---\n`;

describe("safeWritePage", () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("writes a new file when target does not exist", async () => {
    const p = join(dir, "new.md");
    const content = FM() + "\n## Overview\n\nFresh content.\n";
    const r = await safeWritePage(p, content);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.isNew).toBe(true);
      expect(r.data.oldBodyBytes).toBe(0);
    }
    expect(readFileSync(p, "utf8")).toBe(content);
  });

  it("overwrites when body size is similar", async () => {
    const p = join(dir, "page.md");
    const original = FM() + "\n## Overview\n\n" + "A".repeat(500) + "\n";
    writeFileSync(p, original);
    const updated = FM("tags: [x]\n") + "\n## Overview\n\n" + "A".repeat(500) + "\n";
    const r = await safeWritePage(p, updated);
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(updated);
  });

  it("rejects writes that collapse the body below the ratio threshold", async () => {
    const p = join(dir, "page.md");
    const original = FM() + "\n## Overview\n\n" + "B".repeat(2000) + "\n";
    writeFileSync(p, original);
    const truncated = FM() + "\n## TL;DR\n\n";
    const r = await safeWritePage(p, truncated);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("BODY_TRUNCATION_GUARD");
    }
    // File preserved
    expect(readFileSync(p, "utf8")).toBe(original);
  });

  it("allows truncation for small files (below minOldBodyBytes)", async () => {
    const p = join(dir, "small.md");
    const original = FM() + "\nTiny.\n"; // body ~7 bytes — below 200-byte threshold
    writeFileSync(p, original);
    const tinier = FM() + "\n";
    const r = await safeWritePage(p, tinier);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.guardSkippedSmall).toBe(true);
  });

  it("respects custom minBodyRatio = null (guard disabled)", async () => {
    const p = join(dir, "page.md");
    const original = FM() + "\n## Overview\n\n" + "C".repeat(2000) + "\n";
    writeFileSync(p, original);
    const collapsed = FM() + "\n";
    const r = await safeWritePage(p, collapsed, { minBodyRatio: null });
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(collapsed);
  });

  it("respects custom minBodyRatio = 0.9 (stricter)", async () => {
    const p = join(dir, "page.md");
    const original = FM() + "\n" + "D".repeat(1000) + "\n";
    writeFileSync(p, original);
    // Lose ~20% of body — would pass default 0.5 but fail at 0.9
    const slightlyLess = FM() + "\n" + "D".repeat(800) + "\n";
    const r = await safeWritePage(p, slightlyLess, { minBodyRatio: 0.9 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("BODY_TRUNCATION_GUARD");
  });

  it("uses atomic rename (no .tmp file left behind on success)", async () => {
    const p = join(dir, "page.md");
    const content = FM() + "\n" + "E".repeat(500) + "\n";
    await safeWritePage(p, content);
    const entries = readdirSync(dir);
    expect(entries.some(n => n.endsWith(".tmp"))).toBe(false);
    expect(entries).toContain("page.md");
  });

  it("short-circuits when content is unchanged (no mtime bump)", async () => {
    const p = join(dir, "page.md");
    const content = FM() + "\n" + "F".repeat(500) + "\n";
    writeFileSync(p, content);
    const mtimeBefore = require("node:fs").statSync(p).mtimeMs;
    // Sleep ~10ms to ensure mtime resolution would otherwise show a delta
    await new Promise(r => setTimeout(r, 10));
    const r = await safeWritePage(p, content);
    expect(r.ok).toBe(true);
    const mtimeAfter = require("node:fs").statSync(p).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("does not leak temp files on guard rejection", async () => {
    const p = join(dir, "page.md");
    const original = FM() + "\n" + "G".repeat(2000) + "\n";
    writeFileSync(p, original);
    await safeWritePage(p, FM() + "\n");
    const entries = readdirSync(dir);
    expect(entries.filter(n => n.endsWith(".tmp")).length).toBe(0);
  });
});
