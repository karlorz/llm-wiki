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
  measureDirtyVolume,
  runWritePreflight,
} from "../../src/utils/vault-write-gates.js";

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
