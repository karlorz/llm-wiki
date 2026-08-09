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

function fakeGnuStatBin(epoch: number): string {
  const bin = mkdtempSync(join(tmpdir(), "skillwiki-hook-stat-"));
  const file = join(bin, "stat");
  writeFileSync(
    file,
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%Y" ]; then
  printf '${epoch}\\n'
  exit 0
fi
if [ "\${1:-}" = "-f" ] && [ "\${2:-}" = "%m" ]; then
  printf '/\\n'
  exit 0
fi
exit 64
`,
  );
  chmodSync(file, 0o755);
  return bin;
}

describe("SessionStart hook", () => {
  it("defaults to the built-in adaptive native workflow without project config", () => {
    const project = tempProject();

    const context = runClaudeHook(project);

    expect(context).toContain("## Project Workflow Profile");
    expect(context).toContain("- `workflow_selection`: `adaptive`");
    expect(context).toContain("- `workflow_profile`: `native`");
    expect(context).toContain("- authority: `builtin_adaptive`");
    expect(context).toContain("- `prd_layer`: `manual`");
    expect(context).toContain("- `prd_pipeline`: `single-pass`");
    expect(context).toContain("Do not force Superpowers or `EnterPlanMode` gating.");
  });

  it("keeps installed or configured providers inactive under fixed native", () => {
    const project = tempProject();
    writeDevLoopConfig(
      project,
      "workflow_selection: fixed\nworkflow_profile: native\nprd_layer: superpowers",
    );

    const context = runClaudeHook(project);

    expect(context).toContain("## Project Workflow Profile");
    expect(context).toContain("Detected `.claude/dev-loop.config.md`");
    expect(context).toContain("- `workflow_selection`: `fixed`");
    expect(context).toContain("- `workflow_profile`: `native`");
    expect(context).toContain("- `prd_layer`: `superpowers`");
    expect(context).toContain("- `prd_pipeline`: `single-pass`");
    expect(context).toContain("Installation proves availability, never activation.");
    expect(context).toContain("Do not force Superpowers or `EnterPlanMode` gating.");
  });

  it("selects guided adaptively from durable capability evidence", () => {
    const project = tempProject();
    writeDevLoopConfig(
      project,
      "workflow_selection: adaptive\nworkflow_capability: needs-guidance\nworkflow_risk: routine\nprd_layer: tdd",
    );

    const context = runClaudeHook(project);

    expect(context).toContain("- `workflow_selection`: `adaptive`");
    expect(context).toContain("- `workflow_profile`: `guided`");
    expect(context).toContain("- `workflow_capability`: `needs-guidance`");
    expect(context).toContain("- `prd_pipeline`: `tdd-first`");
    expect(context).toContain("Use only targeted guidance");
    expect(context).toContain("do not run the complete Superpowers sequence");
  });

  it("activates full only from an explicit fixed profile", () => {
    const project = tempProject();
    writeDevLoopConfig(
      project,
      "workflow_selection: fixed\nworkflow_profile: full\nprd_layer: superpowers\nprd_pipeline: full",
    );

    const context = runClaudeHook(project);

    expect(context).toContain("- `workflow_profile`: `full`");
    expect(context).toContain("- authority: `project`");
    expect(context).toContain("Explicit full compatibility workflow is active.");
    expect(context).toContain("ensure `EnterPlanMode` is gated with `wiki-gate-plan-mode`");
  });

  it("keeps explicit legacy superpowers full configuration compatible", () => {
    const project = tempProject();
    mkdirSync(join(project, "packages", "cli"), { recursive: true });
    writeDevLoopConfig(project, "prd_layer: superpowers\nprd_pipeline: full");

    const context = runClaudeHook(join(project, "packages", "cli"));

    expect(context).toContain("- `workflow_selection`: `fixed`");
    expect(context).toContain("- `workflow_profile`: `full`");
    expect(context).toContain("- authority: `project_legacy`");
    expect(context).toContain("- `prd_layer`: `superpowers`");
    expect(context).toContain("- `prd_pipeline`: `full`");
  });

  it("fails closed for fixed selection without a profile", () => {
    const project = tempProject();
    writeDevLoopConfig(project, "workflow_selection: fixed\nprd_layer: superpowers");

    const context = runClaudeHook(project);

    expect(context).toContain("- `workflow_profile`: `unresolved`");
    expect(context).toContain("- workflow status: `unresolved`");
    expect(context).toContain("fixed selection requires `workflow_profile`");
    expect(context).toContain("Fail closed");
    expect(context).not.toContain("Explicit full compatibility workflow is active.");
  });

  it("declares a Codex-specific SessionStart hook entrypoint", () => {
    const manifest = JSON.parse(readFileSync(CODEX_HOOKS_MANIFEST, "utf8"));
    const hook = manifest.hooks.SessionStart[0].hooks[0];

    expect(manifest.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
    expect(hook.command).toContain("${PLUGIN_ROOT}/hooks/run-hook.cmd");
    expect(hook.command).toContain("session-start-codex");
  });

  it("Claude and Codex inject the same resolved workflow policy", () => {
    const project = tempProject();
    writeDevLoopConfig(
      project,
      "workflow_selection: adaptive\nworkflow_risk: elevated\nprd_layer: tdd",
    );

    const claudeContext = runClaudeHook(project);
    const codexContext = runCodexHook(project);

    for (const expected of [
      "- `workflow_selection`: `adaptive`",
      "- `workflow_profile`: `guided`",
      "- `workflow_risk`: `elevated`",
      "- authority: `project`",
      "- `prd_layer`: `tdd`",
      "- `prd_pipeline`: `tdd-first`",
    ]) {
      expect(claudeContext).toContain(expected);
      expect(codexContext).toContain(expected);
    }
    expect(codexContext).toContain("Skillwiki is active for this workspace.");
    expect(codexContext).toContain("name: using-skillwiki");
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

  it("reads GNU stat mtime before the BSD stat fallback", () => {
    const project = tempProject();
    const vault = tempVault();
    const statBin = fakeGnuStatBin(Math.floor(Date.now() / 1000));
    writeCacheBrief(vault, "# Session Brief\n\nLinux cached memory capsule.\n");

    const context = runClaudeHook(project, {
      WIKI_PATH: vault,
      PATH: `${statBin}:${process.env.PATH ?? ""}`,
    });

    expect(context).toContain("## Dynamic Session Memory");
    expect(context).toContain("Linux cached memory capsule.");
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

  it("injects Runtime Host Context from the skillwiki fleet context helper", () => {
    const project = tempProject();
    const vault = tempVault();
    const bin = fakeSkillwikiBin(`#!/usr/bin/env bash
if [ "\${1:-}" = "--human" ] && [ "\${2:-}" = "fleet" ] && [ "\${3:-}" = "context" ]; then
  cat <<'OUT'
## Runtime Host Context

- Current machine: \`sg01\` (source: \`SKILLWIKI_HOST_ID\`)
- OS hostname: \`sg01\`
- User: \`root\`
- Workspace: \`/root/llm-wiki\`
- Vault: \`/root/wiki\`
- Fleet role: \`snapshotter\`; protected: \`true\`; writes_to: \`github\`
- Self SSH aliases known in fleet: \`sg01\`, \`cloudsg01\`
- Declared outbound SSH from this source: none
- Guidance: this session is already on \`sg01\`; do not SSH to self aliases unless the user explicitly asks.
OUT
  exit 0
fi
exit 42
`);

    const context = runClaudeHook(project, {
      WIKI_PATH: vault,
      SKILLWIKI_HOST_ID: "sg01",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    });

    expect(context).toContain("## Runtime Host Context");
    expect(context).toContain("Current machine: `sg01`");
    expect(context).toContain("Self SSH aliases known in fleet: `sg01`, `cloudsg01`");
    expect(context.indexOf("## Runtime Host Context")).toBeLessThan(context.indexOf("name: using-skillwiki"));
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
