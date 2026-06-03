import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS_DIR = join(__dirname, "..", "..", "..", "skills");
const CODEX_PLUGIN_ROOT = join(__dirname, "..", "..", "..", "codex-skills");
const CLAUDE_HOOK = join(SKILLS_DIR, "hooks", "session-start");
const CODEX_RUN_HOOK = join(CODEX_PLUGIN_ROOT, "hooks", "run-hook.cmd");
const CODEX_HOOKS_MANIFEST = join(CODEX_PLUGIN_ROOT, "hooks", "hooks-codex.json");

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

function runClaudeHook(cwd: string): string {
  const output = execFileSync("bash", [CLAUDE_HOOK], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: SKILLS_DIR,
    },
    encoding: "utf8",
  });
  return parseAdditionalContext(output);
}

function runCodexHook(cwd: string): string {
  const output = execFileSync("bash", [CODEX_RUN_HOOK, "session-start-codex"], {
    cwd,
    env: {
      ...process.env,
      PLUGIN_ROOT: CODEX_PLUGIN_ROOT,
      CLAUDE_PLUGIN_ROOT: "",
    },
    encoding: "utf8",
  });
  return parseAdditionalContext(output);
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
});
