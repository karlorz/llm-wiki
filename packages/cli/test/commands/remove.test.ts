import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runRemove } from "../../src/commands/remove.js";

const FM = `---
title: t
type: concept
tags: []
sources: []
provenance: research
created: 2026-05-05
updated: 2026-05-05
---

content`;

function makeVault(withIndex = false): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-remove-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "concepts"), { recursive: true });
  if (withIndex) {
    writeFileSync(join(dir, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
  }
  return dir;
}

describe("runRemove", () => {
  it("removes a page, writes tombstone, updates index", async () => {
    const dir = makeVault(true);
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    const r = await runRemove({ vault: dir, page: "alpha" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.removed).toBe("concepts/alpha.md");
      expect(r.result.data.tombstone_path).toBe("meta/delete-intents/concepts__alpha.md.json");
      expect(r.result.data.index_updated).toBe(true);
    }
    expect(existsSync(join(dir, "concepts", "alpha.md"))).toBe(false);
    const tomb = JSON.parse(readFileSync(join(dir, "meta/delete-intents/concepts__alpha.md.json"), "utf8"));
    expect(tomb.schema).toBe("vault-delete-intent/v1");
    expect(tomb.path).toBe("concepts/alpha.md");
    expect(tomb.action).toBe("remove");
    expect(tomb.source).toBe("cli");
    const idx = readFileSync(join(dir, "index.md"), "utf8");
    expect(idx.includes("[[alpha]]")).toBe(false);
  });

  it("remoteDelete requires a remote before removing", async () => {
    const dir = makeVault(false);
    writeFileSync(join(dir, "concepts", "x.md"), FM);
    const r = await runRemove({ vault: dir, page: "concepts/x.md", remoteDelete: true });
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(existsSync(join(dir, "concepts", "x.md"))).toBe(true);
  });

  it("remoteDelete refuses invalid cap before removing", async () => {
    const dir = makeVault(false);
    writeFileSync(join(dir, "concepts", "y.md"), FM);
    const r = await runRemove({
      vault: dir,
      page: "concepts/y.md",
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: true,
      maxRemoteDeletes: 0,
    });
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(existsSync(join(dir, "concepts", "y.md"))).toBe(true);
  });

  it("remoteDelete executes rclone deletefile", async () => {
    const dir = makeVault(false);
    writeFileSync(join(dir, "concepts", "z.md"), FM);
    const calls: string[][] = [];
    const r = await runRemove({
      vault: dir,
      page: "concepts/z.md",
      remote: "seaweed-wiki:cloud/wiki/",
      remoteDelete: true,
      maxRemoteDeletes: 1,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual([["deletefile", "seaweed-wiki:cloud/wiki/concepts/z.md"]]);
    expect(existsSync(join(dir, "concepts", "z.md"))).toBe(false);
    expect(existsSync(join(dir, "meta/delete-intents/concepts__z.md.json"))).toBe(true);
  });

  it("returns FILE_NOT_FOUND for missing page", async () => {
    const dir = makeVault(false);
    const r = await runRemove({ vault: dir, page: "missing" });
    expect(r.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
  });
});
