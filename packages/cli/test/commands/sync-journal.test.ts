import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runSyncJournalClearStale, runSyncJournalList } from "../../src/commands/sync-journal.js";
import { migrationNotesForUpgrade, needs0101Migration } from "../../src/commands/update.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeVaultWithReviewJournal(): { vault: string; opId: string; opPath: string } {
  const vault = mkdtempSync(join(tmpdir(), "sync-journal-"));
  git(vault, ["init"]);
  git(vault, ["branch", "-M", "main"]);
  git(vault, ["config", "user.email", "t@t"]);
  git(vault, ["config", "user.name", "t"]);
  writeFileSync(join(vault, "README.md"), "x\n");
  git(vault, ["add", "."]);
  git(vault, ["commit", "-m", "base"]);
  const base = git(vault, ["rev-parse", "HEAD"]);
  writeFileSync(join(vault, "README.md"), "y\n");
  git(vault, ["commit", "-am", "advance"]);
  const gitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  const opDir = join(gitDir, "vault-sync", "operations");
  mkdirSync(opDir, { recursive: true });
  const opId = "pull-test-journal-1";
  const opPath = join(opDir, `${opId}.env`);
  writeFileSync(
    opPath,
    [
      `operation_id=${opId}`,
      "phase=review-required",
      "handoff=1",
      `original_head=${base}`,
      `target_oid=${base}`,
      `worktree_git_dir=${gitDir}`,
      "reason=stash-failed",
    ].join("\n") + "\n",
  );
  return { vault, opId, opPath };
}

describe("sync journal", () => {
  it("lists review-required journals", () => {
    const { vault, opId } = makeVaultWithReviewJournal();
    const r = runSyncJournalList({ vault });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.review_required.some((j) => j.operation_id === opId)).toBe(true);
      expect(r.result.data.by_phase["review-required"]).toBeGreaterThanOrEqual(1);
    }
  });

  it("clear-stale --dry-run does not rewrite journal", () => {
    const { vault, opPath } = makeVaultWithReviewJournal();
    const before = readFileSync(opPath, "utf8");
    const r = runSyncJournalClearStale({ vault, dryRun: true });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.dry_run).toBe(true);
      expect(r.result.data.superseded.length).toBe(1);
    }
    expect(readFileSync(opPath, "utf8")).toBe(before);
  });

  it("clear-stale writes complete phase when clean", () => {
    const { vault, opPath } = makeVaultWithReviewJournal();
    const r = runSyncJournalClearStale({ vault, dryRun: false });
    expect(r.result.ok).toBe(true);
    const text = readFileSync(opPath, "utf8");
    expect(text).toMatch(/phase=complete/);
    expect(text).toMatch(/superseded-stale-review-required/);
  });
});

describe("0.10.1 migration notes", () => {
  it("detects upgrade from 0.10.0 to 0.10.1", () => {
    expect(needs0101Migration("0.10.0", "0.10.1")).toBe(true);
    expect(migrationNotesForUpgrade("0.10.0", "0.10.1").some((l) => l.includes("Migration 0.10.1"))).toBe(true);
  });

  it("skips when already on 0.10.1+", () => {
    expect(needs0101Migration("0.10.1", "0.10.2")).toBe(false);
    expect(migrationNotesForUpgrade("0.10.1", "0.10.2")).toEqual([]);
  });
});
