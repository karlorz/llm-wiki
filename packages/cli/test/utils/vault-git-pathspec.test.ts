import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  VAULT_GENERATED_COMMIT_PATHS,
  VAULT_GENERATED_COMMIT_EXCLUDES,
  VAULT_COMMIT_PATHSPEC,
  stageVaultContentChanges,
} from "../../src/utils/vault-git-pathspec.js";

describe("vault-git-pathspec constants", () => {
  it("excludes mirror generated paths with pathspec negation", () => {
    expect(VAULT_GENERATED_COMMIT_EXCLUDES).toHaveLength(VAULT_GENERATED_COMMIT_PATHS.length);
    for (const p of VAULT_GENERATED_COMMIT_PATHS) {
      expect(VAULT_GENERATED_COMMIT_EXCLUDES).toContain(`:!${p}`);
    }
  });

  it("commit pathspec stages repo root minus generated excludes", () => {
    expect(VAULT_COMMIT_PATHSPEC[0]).toBe(".");
    expect(VAULT_COMMIT_PATHSPEC.slice(1)).toEqual(VAULT_GENERATED_COMMIT_EXCLUDES);
  });

  it("includes work-complete journals in generated commit excludes", () => {
    expect(VAULT_GENERATED_COMMIT_PATHS).toContain(".skillwiki/work-complete");
    expect(VAULT_GENERATED_COMMIT_PATHS).toContain(".skillwiki/managed-write.lock");
  });

  it("stageVaultContentChanges does not leave work-complete journals staged", () => {
    const vault = mkdtempSync(join(tmpdir(), "pathspec-wc-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: vault });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: vault });
    execFileSync("git", ["config", "user.name", "t"], { cwd: vault });
    writeFileSync(join(vault, "SCHEMA.md"), "# schema\n");
    execFileSync("git", ["add", "SCHEMA.md"], { cwd: vault });
    execFileSync("git", ["commit", "-m", "init"], { cwd: vault });

    mkdirSync(join(vault, ".skillwiki", "work-complete"), { recursive: true });
    writeFileSync(join(vault, ".skillwiki", "work-complete", "deadbeef.env"), "phase=done\n");
    writeFileSync(join(vault, "note.md"), "keep\n");

    stageVaultContentChanges(vault);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: vault,
      encoding: "utf8",
    });
    expect(staged).toContain("note.md");
    expect(staged).not.toContain("work-complete");
  });
});
