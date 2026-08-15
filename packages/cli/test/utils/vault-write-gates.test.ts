import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_HYGIENE_CONTRACT,
  DEFAULT_CAPTURE_BUDGET,
  DEFAULT_DIRTY_VOLUME_THRESHOLD,
  evaluateCaptureBudget,
  evaluateDirtyVolumeGate,
  evaluateMissionCycleGate,
  GateError,
  HYGIENE_COMMANDS,
  isHygieneCommand,
  measureDirtyVolume,
  runWritePreflight,
} from "../../src/utils/vault-write-gates.js";
import { buildCliSurface } from "../../src/utils/cli-surface.js";

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

describe("HYGIENE_COMMANDS registry coverage", () => {
  // Families whose EVERY registered subcommand form must be classified hygiene:
  // a mutating subcommand added to the CLI surface without a HYGIENE_COMMANDS
  // entry regresses the M1 dirty-volume gate (2026-08-13 outage root cause).
  const HYGIENE_FAMILY_ROOTS = ["sync", "log", "index", "projections", "fleet"] as const;
  // Standalone hygiene verbs registered as top-level commands.
  const HYGIENE_ROOT_VERBS = [
    "write-preflight",
    "work-complete",
    "work-validate",
    "doctor",
    "health",
    "lint",
    "status",
    "path",
  ] as const;

  it("covers every executable subcommand form the CLI surface registers under hygiene families", () => {
    const surface = buildCliSurface();
    const familyKeys = HYGIENE_FAMILY_ROOTS.flatMap((root) =>
      [...surface.keys()].filter((key) => key.startsWith(`${root}.`)),
    );
    // Group parents (e.g. "sync journal") register no action of their own:
    // they are not executable forms, cannot mutate, and must NOT be hygiene.
    const groupKeys = familyKeys.filter((key) =>
      familyKeys.some((k) => k.startsWith(`${key}.`)),
    );
    expect(groupKeys).toEqual(["sync.journal"]);
    const missing: string[] = [];
    for (const key of familyKeys) {
      if (groupKeys.includes(key)) continue;
      const form = key.replace(/\./g, " ");
      if (!isHygieneCommand(form)) missing.push(form);
    }
    expect(missing).toEqual([]);
  });

  it("covers every hygiene root verb registered on the surface", () => {
    const surface = buildCliSurface();
    for (const verb of HYGIENE_ROOT_VERBS) {
      expect(surface.has(verb), `hygiene verb ${verb} missing from surface`).toBe(true);
      expect(isHygieneCommand(verb), `${verb} must be hygiene`).toBe(true);
    }
  });

  it("covers the mutating --fix form registered on lint", () => {
    const surface = buildCliSurface();
    expect(surface.get("lint")!.has("--fix")).toBe(true);
    expect(isHygieneCommand("lint --fix")).toBe(true);
  });

  it("every HYGIENE_COMMANDS member resolves to a registered surface form", () => {
    const surface = buildCliSurface();
    const unresolved: string[] = [];
    for (const member of HYGIENE_COMMANDS) {
      const words = member.split(" ");
      const key = words.filter((w) => !w.startsWith("--")).join(".");
      const flagsFor = surface.get(key);
      if (!flagsFor) {
        unresolved.push(member);
        continue;
      }
      for (const flag of words.filter((w) => w.startsWith("--"))) {
        if (!flagsFor.has(flag)) unresolved.push(member);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("snapshot: HYGIENE_COMMANDS is exactly the reviewed set (add/remove fails on purpose)", () => {
    expect([...HYGIENE_COMMANDS].sort()).toEqual([
      "doctor",
      "fleet context",
      "fleet health",
      "fleet validate",
      "health",
      "index rebuild",
      "lint",
      "lint --fix",
      "log materialize",
      "log migrate-legacy",
      "path",
      "projections materialize",
      "projections repair-legacy",
      "status",
      "sync journal clear-stale",
      "sync journal list",
      "sync lint-delta",
      "sync lock",
      "sync peers",
      "sync pull",
      "sync push",
      "sync resolve-derived",
      "sync status",
      "sync unlock",
      "work-complete",
      "work-validate",
      "write-preflight",
    ]);
  });
});

describe("M1 dirty volume gate", () => {
  it("allows when expanded dirty count is under threshold", () => {
    const vault = makeGitVault("dirty-under");
    writeFileSync(join(vault, "one.md"), "x\n");
    const report = measureDirtyVolume(vault);
    expect(report.is_git_repo).toBe(true);
    expect(report.expanded_files).toBeGreaterThanOrEqual(1);
    expect(report.expanded_files).toBeLessThan(DEFAULT_DIRTY_VOLUME_THRESHOLD);

    const gate = evaluateDirtyVolumeGate({ vault, threshold: 10 });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("under_threshold");
  });

  it("refuses when expanded dirty count exceeds threshold with bucket detail", () => {
    const vault = makeGitVault("dirty-over");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(vault, "raw", "transcripts", `2026-07-21-note-${i}.md`), `n${i}\n`);
    }
    const gate = evaluateDirtyVolumeGate({ vault, threshold: 5, command: "observe" });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe(GateError.VAULT_DIRTY_BACKLOG);
      expect(gate.report.expanded_files).toBeGreaterThan(5);
      expect(gate.report.buckets.some((b) => b.bucket === "raw")).toBe(true);
      expect(gate.humanHint).toMatch(/exceeds threshold/);
    }
  });

  it("allows hygiene commands even when over threshold", () => {
    const vault = makeGitVault("dirty-hygiene");
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(vault, `noise-${i}.md`), "n\n");
    }
    const gate = evaluateDirtyVolumeGate({
      vault,
      threshold: 2,
      command: "work-complete",
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("hygiene");
  });

  it("allows 'lint --fix' even when dirty count exceeds threshold (incident root cause)", () => {
    const vault = makeGitVault("dirty-lint-fix");
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(vault, `noise-${i}.md`), "n\n");
    }
    const gate = evaluateDirtyVolumeGate({
      vault,
      threshold: 50,
      command: "lint --fix",
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("hygiene");
  });

  it("allows 'lint' (report-only) as hygiene even when over threshold", () => {
    const vault = makeGitVault("dirty-lint-report");
    for (let i = 0; i < 60; i++) {
      writeFileSync(join(vault, `noise-${i}.md`), "n\n");
    }
    const gate = evaluateDirtyVolumeGate({
      vault,
      threshold: 50,
      command: "lint",
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("hygiene");
  });

  it("expands untracked directories (porcelain under-report)", () => {
    const vault = makeGitVault("dirty-expand");
    mkdirSync(join(vault, "projects", "playground", "work", "2026-07-21-pilot-q-cycle-504"), {
      recursive: true,
    });
    writeFileSync(
      join(vault, "projects", "playground", "work", "2026-07-21-pilot-q-cycle-504", "spec.md"),
      "spec\n",
    );
    writeFileSync(
      join(vault, "projects", "playground", "work", "2026-07-21-pilot-q-cycle-504", "plan.md"),
      "plan\n",
    );
    const report = measureDirtyVolume(vault);
    // one ?? dir line in porcelain, but expanded_files >= 2
    expect(report.porcelain_lines).toBeGreaterThanOrEqual(1);
    expect(report.expanded_files).toBeGreaterThanOrEqual(2);
  });

  it("preserves leading space on first porcelain line (index.md not ndex.md)", () => {
    const vault = makeGitVault("dirty-space-xy");
    // Commit a file then modify it so status is " M path" (space in X column).
    writeFileSync(join(vault, "index.md"), "v1\n");
    git(vault, ["add", "index.md"]);
    git(vault, ["commit", "-m", "add index"]);
    writeFileSync(join(vault, "index.md"), "v2\n");
    // Ensure index.md is the first porcelain line (no untracked before it).
    const report = measureDirtyVolume(vault);
    expect(report.buckets.some((b) => b.bucket === "index.md")).toBe(true);
    expect(report.buckets.some((b) => b.bucket === "ndex.md")).toBe(false);
  });
});

describe("M2 mission cycle / diminishing returns gate", () => {
  it("allows clean prior artifact", () => {
    const gate = evaluateMissionCycleGate({
      priorArtifactText: "# Cycle 1\n\nNew decision: ship feature X.\n",
      missionKind: "pilot-q",
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("clean");
  });

  it("refuses when prior artifact declares saturated", () => {
    const body = `
## Explicit hold

Enablement **saturated** (510–511). **No further PE cash-copy / enablement batches** unless smoke red.
Next action is **human send only**.
`;
    const gate = evaluateMissionCycleGate({
      priorArtifactText: body,
      missionKind: "pilot-q",
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe(GateError.DIMINISHING_RETURNS);
      expect(gate.reason).toBe("saturated_text");
      expect(gate.signals.length).toBeGreaterThan(0);
    }
  });

  it("refuses on consecutive no-new-decision streak", () => {
    const gate = evaluateMissionCycleGate({
      consecutiveNoNewDecision: 3,
      noDecisionThreshold: 3,
      missionKind: "research-cycle",
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe(GateError.DIMINISHING_RETURNS);
      expect(gate.reason).toBe("no_decision_streak");
    }
  });

  it("allows saturated mission when humanAllow is set", () => {
    const gate = evaluateMissionCycleGate({
      priorArtifactText: "status: saturated — stop the loop",
      humanAllow: true,
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("human_allow");
  });
});

describe("M3 capture budget gate", () => {
  it("allows when under daily budget", () => {
    const vault = makeGitVault("budget-under");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    writeFileSync(
      join(vault, "raw", "transcripts", "2026-07-21-note-portfolio-lab-investigate-1.md"),
      "---\nproject: portfolio-lab\ningested: 2026-07-21\n---\nbody\n",
    );
    const gate = evaluateCaptureBudget({
      vault,
      project: "portfolio-lab",
      day: "2026-07-21",
      budget: 5,
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) {
      expect(gate.reason).toBe("under_budget");
      expect(gate.report.used).toBe(1);
      expect(gate.report.remaining).toBe(4);
    }
  });

  it("refuses when budget exhausted and documents hygiene contract", () => {
    const vault = makeGitVault("budget-over");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(vault, "raw", "transcripts", `2026-07-21-note-portfolio-lab-investigate-${i}.md`),
        `---\nproject: portfolio-lab\ningested: 2026-07-21\n---\nn${i}\n`,
      );
    }
    const gate = evaluateCaptureBudget({
      vault,
      project: "portfolio-lab",
      day: "2026-07-21",
      budget: 3,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.code).toBe(GateError.CAPTURE_BUDGET_EXHAUSTED);
      expect(gate.report.used).toBe(3);
      expect(gate.humanHint).toContain(CAPTURE_HYGIENE_CONTRACT.slice(0, 40));
    }
  });

  it("P0 severity escapes exhausted budget", () => {
    const vault = makeGitVault("budget-p0");
    mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
    for (let i = 0; i < 2; i++) {
      writeFileSync(
        join(vault, "raw", "transcripts", `2026-07-21-bug-portfolio-lab-${i}.md`),
        `---\nproject: portfolio-lab\ningested: 2026-07-21\n---\nb${i}\n`,
      );
    }
    const gate = evaluateCaptureBudget({
      vault,
      project: "portfolio-lab",
      day: "2026-07-21",
      budget: 1,
      severity: "P0",
    });
    expect(gate.allowed).toBe(true);
    if (gate.allowed) expect(gate.reason).toBe("p0_escape");
  });

  it("default budget constant is documented positive bound", () => {
    expect(DEFAULT_CAPTURE_BUDGET).toBeGreaterThan(0);
    expect(CAPTURE_HYGIENE_CONTRACT).toMatch(/daily budget/i);
  });
});

describe("runWritePreflight combined", () => {
  it("refuses dirty over threshold via combined entry", () => {
    const vault = makeGitVault("preflight-dirty");
    for (let i = 0; i < 6; i++) writeFileSync(join(vault, `f${i}.md`), "x\n");
    const r = runWritePreflight({
      vault,
      command: "observe",
      dirtyThreshold: 3,
      checks: ["dirty"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.allowed).toBe(false);
      expect(r.data.refused.some((x) => x.code === GateError.VAULT_DIRTY_BACKLOG)).toBe(true);
    }
  });

  it("allows clean under-threshold vault", () => {
    const vault = makeGitVault("preflight-clean");
    const r = runWritePreflight({
      vault,
      command: "observe",
      dirtyThreshold: 50,
      checks: ["dirty"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.allowed).toBe(true);
  });
});
