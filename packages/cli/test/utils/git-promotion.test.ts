import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isGitPresentationPath,
  isGitPromotablePath,
  isMarkdownInventoryPath,
  isS3OwnedPath,
} from "../../src/utils/git-promotion.js";

const policyCases = [
  ["concepts/example.md", true],
  ["projects/example/work/2026-09-15-task/spec.md", true],
  ["meta/log-events/2026-09-15/event.json", false],
  [".drafts/private.md", false],
  ["tmp/report.md", false],
  ["logs/run.md", false],
  [".superpowers/session.md", false],
  [".skillwiki/work-complete/retry.md", false],
  [".skillwiki", false],
  ["tmp", false],
  ["meta/log-events", false],
  ["raw/._.DS_Store", false],
  [".conflict-copy.md", false],
] as const;

describe("isGitPromotablePath", () => {
  it.each(policyCases)("classifies %s", (path, expected) => {
    expect(isGitPromotablePath(path)).toBe(expected);
  });

  it("stays in parity with the snapshot shell classifier", () => {
    const policy = fileURLToPath(
      new URL("../../../vault-sync/scripts/lib/git-promotion-policy.sh", import.meta.url),
    );
    const script = `. "$1"; shift; for path in "$@"; do if snapshot_non_promotable_path "$path"; then printf '0\\n'; else printf '1\\n'; fi; done`;
    const result = spawnSync("bash", ["-c", script, "parity", policy, ...policyCases.map(([path]) => path)], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      policyCases.map(([path]) => (isGitPromotablePath(path) ? "1" : "0")),
    );
  });
});

describe("vault path classes", () => {
  it("keeps ledger data S3-owned without presenting it in Git", () => {
    const ledger = "meta/log-events/2026-09-15/event.json";
    expect(isS3OwnedPath(ledger)).toBe(true);
    expect(isGitPromotablePath(ledger)).toBe(false);
    expect(isGitPresentationPath(ledger)).toBe(false);
    expect(isMarkdownInventoryPath(ledger)).toBe(false);
  });

  it("keeps Markdown inventory semantics distinct from local scratch ownership", () => {
    expect(isMarkdownInventoryPath("concepts/example.md")).toBe(true);
    expect(isMarkdownInventoryPath("meta/log-events/event.json")).toBe(false);
    expect(isS3OwnedPath(".skillwiki/managed-write.lock")).toBe(false);
    expect(isS3OwnedPath(".obsidian/plugins/remotely-save/data.json")).toBe(false);
    expect(isS3OwnedPath("index.md")).toBe(true);
  });
});
