import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTopicMapCheck } from "../../src/commands/topic-map-check.js";

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-04
updated: 2026-05-04
---

content
`;

function makeVault(pageCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  for (let i = 0; i < pageCount; i++) {
    writeFileSync(join(dir, "concepts", `page-${i}.md`), FM);
  }
  return dir;
}

describe("runTopicMapCheck", () => {
  it("under threshold (5 pages, threshold 200) -> recommended: false", async () => {
    const dir = makeVault(5);
    const r = await runTopicMapCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.recommended).toBe(false);
      expect(r.result.data.page_count).toBe(5);
      expect(r.result.data.threshold).toBe(200);
    }
  });

  it("at threshold (200 pages, threshold 200) -> recommended: true, page_count: 200", async () => {
    const dir = makeVault(200);
    const r = await runTopicMapCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.recommended).toBe(true);
      expect(r.result.data.page_count).toBe(200);
    }
  });

  it("custom threshold (5 pages, threshold 3) -> recommended: true", async () => {
    const dir = makeVault(5);
    const r = await runTopicMapCheck({ vault: dir, threshold: 3 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.recommended).toBe(true);
      expect(r.result.data.threshold).toBe(3);
    }
  });

  it("invalid vault -> exitCode 9, result.ok: false", async () => {
    const r = await runTopicMapCheck({ vault: "/no/such/path" });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
  });
});
