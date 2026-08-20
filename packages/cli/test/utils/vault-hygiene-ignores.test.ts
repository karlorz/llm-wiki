import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VAULT_HYGIENE_GITIGNORE_PATTERNS,
  VAULT_SYNC_FILTER_REQUIRED_EXCLUDES,
  missingIgnorePatterns,
  mergeGitignore,
  renderVaultGitignoreTemplate,
} from "../../src/utils/vault-hygiene-ignores.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("vault hygiene ignore contract", () => {
  it("lists local scratch and never session-brief or agent-memory-trends", () => {
    expect(VAULT_HYGIENE_GITIGNORE_PATTERNS).toContain(".skillwiki/work-complete/");
    expect(VAULT_HYGIENE_GITIGNORE_PATTERNS).toContain(".skillwiki/last-op.json");
    expect(VAULT_HYGIENE_GITIGNORE_PATTERNS).toContain(".skillwiki/managed-write.lock");
    expect(VAULT_HYGIENE_GITIGNORE_PATTERNS.join("\n")).not.toMatch(/session-brief/);
    expect(VAULT_HYGIENE_GITIGNORE_PATTERNS.join("\n")).not.toMatch(/agent-memory-trends/);
  });

  it("requires rclone excludes for work-complete and last-op", () => {
    expect(VAULT_SYNC_FILTER_REQUIRED_EXCLUDES).toContain(".skillwiki/work-complete/");
    expect(VAULT_SYNC_FILTER_REQUIRED_EXCLUDES).toContain(".skillwiki/last-op.json");
    expect(VAULT_SYNC_FILTER_REQUIRED_EXCLUDES).toContain(".skillwiki/sync.lock");
  });

  it("reports missing gitignore patterns", () => {
    const existing = ".skillwiki/last-op.json\n.skillwiki/graph.json\n";
    expect(missingIgnorePatterns(existing, VAULT_HYGIENE_GITIGNORE_PATTERNS)).toContain(
      ".skillwiki/work-complete/",
    );
    expect(missingIgnorePatterns(existing, [".skillwiki/last-op.json"])).toEqual([]);
  });

  it("merges missing hygiene lines without dropping user entries", () => {
    const existing = "# mine\ncustom-keep\n.skillwiki/last-op.json\n";
    const merged = mergeGitignore(existing, VAULT_HYGIENE_GITIGNORE_PATTERNS);
    expect(merged.changed).toBe(true);
    expect(merged.text).toContain("custom-keep");
    expect(merged.text).toContain(".skillwiki/work-complete/");
    expect(merged.added).toContain(".skillwiki/work-complete/");
  });

  it("is a no-op merge when every required pattern is already present", () => {
    const existing = renderVaultGitignoreTemplate();
    const merged = mergeGitignore(existing, VAULT_HYGIENE_GITIGNORE_PATTERNS);
    expect(merged.changed).toBe(false);
    expect(merged.added).toEqual([]);
    expect(merged.text).toBe(existing);
  });

  it("template documents published-cache exception and includes work-complete", () => {
    const text = renderVaultGitignoreTemplate();
    expect(text).toContain(".skillwiki/work-complete/");
    expect(text).toMatch(/session-brief/);
    expect(text).toMatch(/agent-memory-trends/);
    expect(text).toContain(".obsidian/workspace.json");
  });

  it("repo wiki-push-filters.txt includes every required rclone exclude", () => {
    const filter = readFileSync(
      join(REPO_ROOT, "packages", "vault-sync", "filters", "wiki-push-filters.txt"),
      "utf8",
    );
    expect(missingIgnorePatterns(filter, VAULT_SYNC_FILTER_REQUIRED_EXCLUDES)).toEqual([]);
  });
});
