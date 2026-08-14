import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

vi.mock("../../src/commands/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/sync.js")>();
  return {
    ...actual,
    runSyncPeers: (input: Parameters<typeof actual.runSyncPeers>[0]) =>
      actual.runSyncPeers({ ...input, processSnapshot: "" }),
  };
});

import { runProjectIndex } from "../../src/commands/project-index.js";

const CONCEPT_FM = `---
title: Alpha Concept
created: 2026-05-08
updated: 2026-05-08
type: concept
tags: [test]
sources: [raw/test.md]
provenance: project
provenance_projects: ["[[acme]]"]
---

# Alpha Concept

Some content.
`;

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "project-index-managed-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(dir, "projects", "acme"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  writeFileSync(join(dir, "concepts", "alpha.md"), CONCEPT_FM);
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("runProjectIndex guarded apply", () => {
  it("writes knowledge.md through the managed write transaction and is byte-idempotent", async () => {
    const dir = makeVault();
    const indexPath = join(dir, "projects", "acme", "knowledge.md");

    const first = await runProjectIndex({ vault: dir, slug: "acme", apply: true });
    const firstStat = statSync(indexPath);
    const firstBytes = readFileSync(indexPath, "utf8");
    const second = await runProjectIndex({ vault: dir, slug: "acme", apply: true });
    const secondStat = statSync(indexPath);

    expect(first.exitCode).toBe(0);
    expect(first.result.ok).toBe(true);
    if (first.result.ok) {
      expect(first.result.data.changed).toBe(true);
      expect(first.result.data.write_mode).toBeDefined();
    }
    expect(firstBytes).toContain("Alpha Concept");
    expect(firstBytes).toContain("[[concepts/alpha]]");
    expect(second.result.ok).toBe(true);
    if (second.result.ok) {
      expect(second.result.data.changed).toBe(false);
    }
    expect(readFileSync(indexPath, "utf8")).toBe(firstBytes);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("refuses apply through the managed peer gate when a foreign sync lock is held", async () => {
    const dir = makeVault();
    const indexPath = join(dir, "projects", "acme", "knowledge.md");
    writeFileSync(indexPath, "# old\n");
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    writeFileSync(join(dir, ".skillwiki", "sync.lock"), JSON.stringify({
      session_id: "foreign-session",
      pid: 999999,
      cwd: dir,
      summary: "foreign writer",
      acquired: new Date().toISOString(),
      expires: new Date(Date.now() + 600000).toISOString(),
      is_self: false,
    }));

    const r = await runProjectIndex({ vault: dir, slug: "acme", apply: true });

    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("PREFLIGHT_FAILED");
    }
    expect(readFileSync(indexPath, "utf8")).toBe("# old\n");
  });
});
