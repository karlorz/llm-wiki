import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  classifyDerivedPath,
  runDerivedConflictResolution,
} from "../../src/commands/derived-conflicts.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeJournal(vault: string, opId: string, phase = "rebasing"): void {
  const jdir = git(vault, ["rev-parse", "--git-path", "vault-sync/operations"]);
  const abs = jdir.startsWith("/") ? jdir : join(vault, jdir);
  mkdirSync(abs, { recursive: true });
  const gitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  writeFileSync(
    join(abs, `${opId}.env`),
    [
      `operation_id=${opId}`,
      `phase=${phase}`,
      "handoff=0",
      `worktree_git_dir=${gitDir}`,
      "",
    ].join("\n"),
  );
}

function seedConflict(vault: string, path: string, base: string, ours: string, theirs: string): void {
  writeFileSync(join(vault, path), base);
  git(vault, ["add", path]);
  git(vault, ["commit", "-m", `base ${path}`]);
  git(vault, ["checkout", "-b", "theirs"]);
  writeFileSync(join(vault, path), theirs);
  git(vault, ["commit", "-am", `theirs ${path}`]);
  git(vault, ["checkout", "main"]);
  writeFileSync(join(vault, path), ours);
  git(vault, ["commit", "-am", `ours ${path}`]);
  try {
    git(vault, ["merge", "theirs"]);
  } catch {
    /* expected */
  }
}

describe("classifyDerivedPath", () => {
  it("classifies known derived paths", () => {
    expect(classifyDerivedPath("index.md")).toBe("root-index");
    expect(classifyDerivedPath("log.md")).toBe("log");
    expect(classifyDerivedPath("SCHEMA.md")).toBe("taxonomy");
    expect(classifyDerivedPath("projects/demo/knowledge.md")).toBe("project-index");
    expect(classifyDerivedPath("queries/semantic.md")).toBe("unknown");
  });
});

describe("runDerivedConflictResolution", () => {
  it("resolves mixed index.md + log.md", async () => {
    const vault = mkdtempSync(join(tmpdir(), "derived-ok-"));
    git(vault, ["init"]);
    git(vault, ["branch", "-M", "main"]);
    git(vault, ["config", "user.email", "t@t"]);
    git(vault, ["config", "user.name", "t"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    for (const d of ["entities", "concepts", "comparisons", "queries", "meta"]) {
      mkdirSync(join(vault, d), { recursive: true });
    }
    const page = (title: string, slug: string) => `---
title: ${title}
type: concept
tags: []
sources: [raw/${slug}.md]
provenance: research
created: 2026-07-15
updated: 2026-07-15
---
`;
    writeFileSync(join(vault, "concepts", "alpha.md"), page("Alpha", "alpha"));
    writeFileSync(join(vault, "index.md"), "# Index\n");
    writeFileSync(join(vault, "log.md"), "# Log\n");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "seed"]);

    // Branch A: alpha in index + local log
    writeFileSync(join(vault, "index.md"), "# Index\n\n- [[concepts/alpha]]\n");
    writeFileSync(join(vault, "log.md"), "# Log\n\n## [2026-07-15] local\n\nL\n");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "ours"]);

    // Branch B from seed: beta page + remote log
    git(vault, ["checkout", "-b", "theirs", "HEAD~1"]);
    mkdirSync(join(vault, "concepts"), { recursive: true });
    writeFileSync(join(vault, "concepts", "beta.md"), page("Beta", "beta"));
    writeFileSync(join(vault, "index.md"), "# Index\n\n- [[concepts/beta]]\n");
    writeFileSync(join(vault, "log.md"), "# Log\n\n## [2026-07-15] remote\n\nR\n");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "theirs"]);
    git(vault, ["checkout", "main"]);
    try {
      git(vault, ["merge", "theirs"]);
    } catch {
      /* expected conflicts on index/log */
    }

    writeJournal(vault, "op-mixed");
    const run = await runDerivedConflictResolution({ vault, operationId: "op-mixed" });
    expect(run.result).toMatchObject({ ok: true, data: { resolved: true } });
    expect(git(vault, ["diff", "--name-only", "--diff-filter=U"])).toBe("");
  });

  it("rolls back completely when a semantic path is mixed in", async () => {
    const vault = mkdtempSync(join(tmpdir(), "derived-rb-"));
    git(vault, ["init"]);
    git(vault, ["branch", "-M", "main"]);
    git(vault, ["config", "user.email", "t@t"]);
    git(vault, ["config", "user.name", "t"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    mkdirSync(join(vault, "queries"), { recursive: true });
    writeFileSync(join(vault, "index.md"), "# Index\nbase\n");
    writeFileSync(join(vault, "log.md"), "# Log\n");
    writeFileSync(join(vault, "queries", "semantic.md"), "# S\nbase\n");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "base"]);

    git(vault, ["checkout", "-b", "theirs"]);
    writeFileSync(join(vault, "index.md"), "# Index\ntheirs\n");
    writeFileSync(join(vault, "log.md"), "# Log\n\n## [2026-07-15] theirs\n\nT\n");
    writeFileSync(join(vault, "queries", "semantic.md"), "# S\ntheirs\n");
    git(vault, ["commit", "-am", "theirs"]);
    git(vault, ["checkout", "main"]);
    writeFileSync(join(vault, "index.md"), "# Index\nours\n");
    writeFileSync(join(vault, "log.md"), "# Log\n\n## [2026-07-15] ours\n\nO\n");
    writeFileSync(join(vault, "queries", "semantic.md"), "# S\nours\n");
    git(vault, ["commit", "-am", "ours"]);
    try {
      git(vault, ["merge", "theirs"]);
    } catch {
      /* expected */
    }

    const originalOursIndex = git(vault, ["show", ":2:index.md"]);
    const originalTheirsIndex = git(vault, ["show", ":3:index.md"]);
    writeJournal(vault, "op-semantic");

    const run = await runDerivedConflictResolution({ vault, operationId: "op-semantic" });
    expect(run.result).toMatchObject({
      ok: true,
      data: { resolved: false, unknown_paths: ["queries/semantic.md"] },
    });
    expect(git(vault, ["diff", "--name-only", "--diff-filter=U"]).split("\n").sort()).toEqual([
      "index.md",
      "log.md",
      "queries/semantic.md",
    ]);
    expect(git(vault, ["show", ":2:index.md"])).toBe(originalOursIndex);
    expect(git(vault, ["show", ":3:index.md"])).toBe(originalTheirsIndex);
  });
});
