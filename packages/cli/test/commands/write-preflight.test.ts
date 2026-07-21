import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runWritePreflightCommand } from "../../src/commands/write-preflight.js";
import { GateError } from "../../src/utils/vault-write-gates.js";
import { runObserve } from "../../src/commands/observe.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeGitVault(label: string): string {
  const vault = mkdtempSync(join(tmpdir(), `${label}-`));
  git(vault, ["init"]);
  git(vault, ["config", "user.email", "t@t"]);
  git(vault, ["config", "user.name", "t"]);
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  git(vault, ["add", "."]);
  git(vault, ["commit", "-m", "init"]);
  return vault;
}

describe("runWritePreflightCommand (CLI entry)", () => {
  it("dirty-over → PREFLIGHT_FAILED + VAULT_DIRTY_BACKLOG", async () => {
    const vault = makeGitVault("cmd-dirty-over");
    for (let i = 0; i < 8; i++) writeFileSync(join(vault, `n${i}.md`), "x\n");
    const r = await runWritePreflightCommand({
      vault,
      command: "observe",
      dirtyThreshold: 3,
      checks: "dirty",
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe(GateError.VAULT_DIRTY_BACKLOG);
    }
  });

  it("dirty-under → allow OK", async () => {
    const vault = makeGitVault("cmd-dirty-under");
    writeFileSync(join(vault, "one.md"), "x\n");
    const r = await runWritePreflightCommand({
      vault,
      command: "observe",
      dirtyThreshold: 20,
      checks: "dirty",
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.data.allowed).toBe(true);
  });

  it("saturated body → DIMINISHING_RETURNS", async () => {
    const vault = makeGitVault("cmd-sat");
    const prior = join(vault, "prior.md");
    writeFileSync(
      prior,
      "Enablement **saturated**. No further batches. human send only.\n",
    );
    const r = await runWritePreflightCommand({
      vault,
      checks: "mission",
      priorArtifactFile: prior,
      missionKind: "pilot-q",
      skipDirty: true,
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe(GateError.DIMINISHING_RETURNS);
  });

  it("clean mission → allow", async () => {
    const vault = makeGitVault("cmd-clean-mission");
    const r = await runWritePreflightCommand({
      vault,
      checks: "mission",
      priorArtifactText: "New decision: prioritize customer outreach this week.",
      skipDirty: true,
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
  });

  it("budget exhausted → CAPTURE_BUDGET_EXHAUSTED", async () => {
    const vault = makeGitVault("cmd-budget");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(vault, "raw", "transcripts", `2026-07-21-note-lab-investigate-${i}.md`),
        `---\nproject: lab\ningested: 2026-07-21\n---\nx\n`,
      );
    }
    const r = await runWritePreflightCommand({
      vault,
      checks: "budget",
      project: "lab",
      captureDay: "2026-07-21",
      captureBudget: 2,
      skipDirty: true,
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe(GateError.CAPTURE_BUDGET_EXHAUSTED);
  });

  it("budget remaining → allow", async () => {
    const vault = makeGitVault("cmd-budget-ok");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    writeFileSync(
      join(vault, "raw", "transcripts", "2026-07-21-note-lab-investigate-0.md"),
      "---\nproject: lab\ningested: 2026-07-21\n---\nx\n",
    );
    const r = await runWritePreflightCommand({
      vault,
      checks: "budget",
      project: "lab",
      captureDay: "2026-07-21",
      captureBudget: 5,
      skipDirty: true,
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
  });
});

describe("runObserve capture budget wiring", () => {
  it("refuses observe when project daily budget exhausted", async () => {
    const vault = makeGitVault("obs-budget");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(vault, "raw", "transcripts", `2026-07-21-note-demo-investigate-${i}.md`),
        `---\nproject: demo\ningested: 2026-07-21\n---\nx\n`,
      );
    }
    const r = await runObserve({
      vault,
      text: "another investigate note",
      project: "demo",
      kind: "note",
      captureBudget: 2,
      captureDay: "2026-07-21",
    });
    expect(r.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) expect(r.result.error).toBe(GateError.CAPTURE_BUDGET_EXHAUSTED);
  });

  it("allows observe under budget", async () => {
    const vault = makeGitVault("obs-ok");
    const r = await runObserve({
      vault,
      text: "first note for project",
      project: "demo",
      kind: "note",
      captureBudget: 5,
      captureDay: "2026-07-21",
    });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.result.ok).toBe(true);
  });
});
