import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const CODEX_PLUGIN_ROOT = join(__dirname, "..", "..", "..", "codex-skills");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CLAUDE_HOOK = join(SKILLS_DIR, "hooks", "session-start");
const CODEX_RUN_HOOK = join(CODEX_PLUGIN_ROOT, "hooks", "run-hook.cmd");
const CODEX_HOOKS_MANIFEST = join(CODEX_PLUGIN_ROOT, "hooks", "hooks-codex.json");
const ROOT_AGY_RUN_HOOK = join(REPO_ROOT, "hooks", "run-hook.cmd");

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), "skillwiki-hook-project-"));
  mkdirSync(join(project, ".claude"), { recursive: true });
  return project;
}

function writeDevLoopConfig(project: string, yaml: string): void {
  writeFileSync(
    join(project, ".claude", "dev-loop.config.md"),
    ["# Dev Loop", "", "```yaml", yaml.trim(), "```", ""].join("\n"),
  );
}

function parseAdditionalContext(output: string): string {
  const parsed = JSON.parse(output);
  return parsed.hookSpecificOutput.additionalContext;
}

function runClaudeHook(cwd: string, extraEnv: Record<string, string> = {}): string {
  const output = execFileSync("bash", [CLAUDE_HOOK], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: SKILLS_DIR,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return parseAdditionalContext(output);
}

function runCodexHook(cwd: string, extraEnv: Record<string, string> = {}): string {
  const output = execFileSync("bash", [CODEX_RUN_HOOK, "session-start-codex"], {
    cwd,
    env: {
      ...process.env,
      PLUGIN_ROOT: CODEX_PLUGIN_ROOT,
      CLAUDE_PLUGIN_ROOT: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return parseAdditionalContext(output);
}

function runRootAgyHook(cwd: string, extraEnv: Record<string, string> = {}): string {
  const output = execFileSync("bash", [ROOT_AGY_RUN_HOOK, "session-start"], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      ...extraEnv,
    },
    encoding: "utf8",
  });
  return parseAdditionalContext(output);
}

function tempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "skillwiki-hook-vault-"));
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  mkdirSync(join(vault, "meta"), { recursive: true });
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(vault, "index.md"), "# Index\n");
  writeFileSync(join(vault, "log.md"), "# Log\n");
  return vault;
}

function writeCacheBrief(vault: string, body: string): string {
  const path = join(vault, ".skillwiki", "session-brief.md");
  writeFileSync(path, body);
  return path;
}

function setAgeHours(path: string, hours: number): void {
  const time = new Date(Date.now() - hours * 60 * 60 * 1000);
  utimesSync(path, time, time);
}

function fakeSkillwikiBin(script: string): string {
  const bin = mkdtempSync(join(tmpdir(), "skillwiki-hook-bin-"));
  const file = join(bin, "skillwiki");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return bin;
}

describe("SessionStart hook", () => {
  it("injects detected PRD mode from project dev-loop config", () => {
    const project = tempProject();
    writeDevLoopConfig(project, "prd_layer: tdd\nprd_pipeline: tdd-first");

    const context = runClaudeHook(project);

    expect(context).toContain("## Project PRD Mode");
    expect(context).toContain("Detected `.claude/dev-loop.config.md`");
    expect(context).toContain("- `prd_layer`: `tdd`");
    expect(context).toContain("- `prd_pipeline`: `tdd-first`");
    expect(context).toContain("Do not assume `superpowers/full` unless the config says so.");
  });

  it("finds dev-loop config from a project subdirectory", () => {
    const project = tempProject();
    mkdirSync(join(project, "packages", "cli"), { recursive: true });
    writeDevLoopConfig(project, "prd_layer: superpowers\nprd_pipeline: full");

    const context = runClaudeHook(join(project, "packages", "cli"));

    expect(context).toContain("## Project PRD Mode");
    expect(context).toContain("- `prd_layer`: `superpowers`");
    expect(context).toContain("- `prd_pipeline`: `full`");
  });

  it("does not fail when one PRD config value is omitted", () => {
    const project = tempProject();
    writeDevLoopConfig(project, "prd_layer: tdd");

    const context = runClaudeHook(project);

    expect(context).toContain("- `prd_layer`: `tdd`");
    expect(context).toContain("- `prd_pipeline`: `unspecified`");
  });

  it("declares a Codex-specific SessionStart hook entrypoint", () => {
    const manifest = JSON.parse(readFileSync(CODEX_HOOKS_MANIFEST, "utf8"));
    const hook = manifest.hooks.SessionStart[0].hooks[0];

    expect(manifest.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
    expect(hook.command).toContain("${PLUGIN_ROOT}/hooks/run-hook.cmd");
    expect(hook.command).toContain("session-start-codex");
  });

  it("Codex hook injects detected PRD mode without CLAUDE_PLUGIN_ROOT", () => {
    const project = tempProject();
    writeDevLoopConfig(project, "prd_layer: tdd\nprd_pipeline: tdd-first");

    const context = runCodexHook(project);

    expect(context).toContain("## Project PRD Mode");
    expect(context).toContain("- `prd_layer`: `tdd`");
    expect(context).toContain("- `prd_pipeline`: `tdd-first`");
    expect(context).toContain("Skillwiki is active for this workspace.");
    expect(context).toContain("name: using-skillwiki");
  });

  it("root Antigravity hook reads using-skillwiki from the root skills mirror", () => {
    const project = tempProject();

    const context = runRootAgyHook(project);

    expect(context).toContain("Skillwiki is active for this workspace.");
    expect(context).toContain("name: using-skillwiki");
    expect(context).not.toContain("Error reading using-skillwiki skill");
  });

  it("injects a fresh cached session brief before the skill guidance", () => {
    const project = tempProject();
    const vault = tempVault();
    writeCacheBrief(vault, "# Session Brief\n\nFresh cached memory capsule.\n");

    const context = runClaudeHook(project, { WIKI_PATH: vault });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("Fresh cached memory capsule.");
    expect(context.indexOf("## Dynamic Session Memory")).toBeLessThan(context.indexOf("name: using-skillwiki"));
  });

  it("uses committed latest-session-brief when the local cache is missing", () => {
    const project = tempProject();
    const vault = tempVault();
    writeFileSync(join(vault, "meta", "latest-session-brief.md"), `---
title: Latest Session Brief
created: 2026-06-11
updated: 2026-06-11
type: meta
tags: [generated, session-brief]
generated_by: skillwiki session-brief
generated_at: 2026-06-11T00:00:00Z
generated_kind: session-brief
---

# Session Brief

Committed memory capsule.
`);

    const context = runClaudeHook(project, { WIKI_PATH: vault });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("Committed memory capsule.");
  });

  it("warns when using a 24-72h stale cache", () => {
    const project = tempProject();
    const vault = tempVault();
    const cache = writeCacheBrief(vault, "# Session Brief\n\nStale but acceptable capsule.\n");
    setAgeHours(cache, 30);

    const context = runClaudeHook(project, { WIKI_PATH: vault });

    expect(context).toContain("Session brief age: stale");
    expect(context).toContain("Stale but acceptable capsule.");
  });

  it("Codex hook injects session memory from the Codex-native root", () => {
    const project = tempProject();
    const vault = tempVault();
    writeCacheBrief(vault, "# Session Brief\n\nCodex cached memory capsule.\n");

    const context = runCodexHook(project, { WIKI_PATH: vault });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("Codex cached memory capsule.");
  });

  it("root Antigravity hook injects session memory from the root mirror", () => {
    const project = tempProject();
    const vault = tempVault();
    writeCacheBrief(vault, "# Session Brief\n\nRoot hook memory capsule.\n");

    const context = runRootAgyHook(project, { WIKI_PATH: vault });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("Root hook memory capsule.");
  });

  it("falls back to read-only session-brief computation when no file exists", () => {
    const project = tempProject();
    const vault = tempVault();
    const bin = fakeSkillwikiBin(`#!/usr/bin/env bash
printf '# Session Brief\\n\\nComputed read-only memory capsule.\\n'
`);

    const context = runClaudeHook(project, {
      WIKI_PATH: vault,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("read-only `skillwiki session-brief --project auto --human` fallback");
    expect(context).toContain("Computed read-only memory capsule.");
  });

  it("keeps startup context when read-only session-brief computation fails", () => {
    const project = tempProject();
    const vault = tempVault();
    const bin = fakeSkillwikiBin(`#!/usr/bin/env bash
exit 42
`);

    const context = runClaudeHook(project, {
      WIKI_PATH: vault,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    expect(context).toContain("Skillwiki is active for this workspace.");
    expect(context).toContain("name: using-skillwiki");
    expect(context).not.toContain("## Dynamic Session Memory");
  });
});
