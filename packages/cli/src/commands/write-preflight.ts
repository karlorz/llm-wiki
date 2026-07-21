/**
 * skillwiki write-preflight — agent-facing vault write gates (M1–M3).
 *
 * Analysis: projects/llm-wiki/work/2026-07-21-vault-uncommitted-backlog-improvements/analysis.md
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import {
  CAPTURE_HYGIENE_CONTRACT,
  DEFAULT_CAPTURE_BUDGET,
  DEFAULT_DIRTY_VOLUME_THRESHOLD,
  DEFAULT_NO_DECISION_STREAK,
  GateError,
  runWritePreflight,
  type WritePreflightOutput,
} from "../utils/vault-write-gates.js";

export interface WritePreflightCommandInput {
  vault: string;
  command?: string;
  dirtyThreshold?: number;
  skipDirty?: boolean;
  priorArtifactText?: string;
  priorArtifactFile?: string;
  consecutiveNoNewDecision?: number;
  noDecisionThreshold?: number;
  humanAllow?: boolean;
  missionKind?: string;
  skipMission?: boolean;
  project?: string;
  captureDay?: string;
  captureBudget?: number;
  severity?: string;
  skipBudget?: boolean;
  /** Comma-separated: dirty,mission,budget,all */
  checks?: string;
}

export async function runWritePreflightCommand(
  input: WritePreflightCommandInput,
): Promise<{ exitCode: number; result: Result<WritePreflightOutput & { hygiene_contract: string }> }> {
  if (!existsSync(input.vault) || !statSync(input.vault).isDirectory()) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err(GateError.VAULT_PATH_INVALID, { path: input.vault }),
    };
  }

  let priorText = input.priorArtifactText;
  if (input.priorArtifactFile) {
    if (!existsSync(input.priorArtifactFile)) {
      return {
        exitCode: ExitCode.FILE_NOT_FOUND,
        result: err("FILE_NOT_FOUND", { path: input.priorArtifactFile }),
      };
    }
    priorText = readFileSync(input.priorArtifactFile, "utf8");
  }

  const checkList = input.checks
    ? (input.checks.split(",").map((s) => s.trim()).filter(Boolean) as Array<
        "dirty" | "mission" | "budget" | "all"
      >)
    : undefined;

  const result = runWritePreflight({
    vault: input.vault,
    command: input.command,
    dirtyThreshold: input.dirtyThreshold ?? DEFAULT_DIRTY_VOLUME_THRESHOLD,
    skipDirty: input.skipDirty,
    priorArtifactText: priorText,
    consecutiveNoNewDecision: input.consecutiveNoNewDecision,
    noDecisionThreshold: input.noDecisionThreshold ?? DEFAULT_NO_DECISION_STREAK,
    humanAllow: input.humanAllow,
    missionKind: input.missionKind,
    skipMission: input.skipMission,
    project: input.project,
    captureDay: input.captureDay,
    captureBudget: input.captureBudget ?? DEFAULT_CAPTURE_BUDGET,
    severity: input.severity,
    skipBudget: input.skipBudget,
    checks: checkList,
  });

  if (!result.ok) {
    const code =
      result.error === GateError.VAULT_PATH_INVALID
        ? ExitCode.VAULT_PATH_INVALID
        : ExitCode.PREFLIGHT_FAILED;
    return { exitCode: code, result };
  }

  if (!result.data.allowed) {
    // Prefer first refuse code for top-level error
    const first = result.data.refused[0];
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err(first?.code ?? GateError.VAULT_DIRTY_BACKLOG, {
        ...result.data,
        hygiene_contract: CAPTURE_HYGIENE_CONTRACT,
      }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      ...result.data,
      hygiene_contract: CAPTURE_HYGIENE_CONTRACT,
    }),
  };
}
