import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { git, gitStrict } from "../utils/git.js";
import { operationId } from "../utils/operation-id.js";
import {
  parseJournalEnv,
  serializeJournalEnv,
  type JournalFields,
} from "../utils/operation-journal.js";
import { appendLastOp } from "../utils/last-op.js";
import { runLogAppend } from "./log-append.js";
import { normalizeWorkItemRel, runWorkValidate } from "./work-validate.js";

/** Vault-local journal under .skillwiki so tests work without a git repo. */
function workCompleteJournalPath(vault: string, opId: string): string {
  return join(vault, ".skillwiki", "work-complete", `${opId}.env`);
}

function readWorkJournal(vault: string, opId: string): JournalFields | null {
  const path = workCompleteJournalPath(vault, opId);
  if (!existsSync(path)) return null;
  try {
    return parseJournalEnv(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeWorkJournal(vault: string, opId: string, fields: JournalFields): void {
  const path = workCompleteJournalPath(vault, opId);
  const dir = join(vault, ".skillwiki", "work-complete");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  const body = serializeJournalEnv(fields, [
    "operation_id",
    "phase",
    "retry_count",
    "work_item",
    "committed",
    "reason",
  ]);
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

export interface WorkCompleteInput {
  vault: string;
  workItem: string;
  /** Optional stable id; derived from vault+workItem when omitted. */
  operationId?: string;
  /** Skip git commit (still journals completion). */
  noCommit?: boolean;
  /** Test hook: fail after this phase name once (for retry fixtures). */
  failAfter?: "validate" | "evidence" | "log" | "projection" | "commit" | null;
}

export interface WorkCompleteDeps {
  writeEvidenceText: typeof atomicWriteText;
}

export interface WorkCompleteOutput {
  operation_id: string;
  work_item: string;
  phases: string[];
  completed: boolean;
  retried: boolean;
  committed: boolean;
  humanHint: string;
}

type Run = { exitCode: number; result: Result<WorkCompleteOutput> };

const DEFAULT_DEPS: WorkCompleteDeps = {
  writeEvidenceText: atomicWriteText,
};

/** Test-only hook factory; production callers use the immutable default dependency. */
export function defaultWorkCompleteDeps(
  overrides: Partial<WorkCompleteDeps> = {},
): WorkCompleteDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

const PHASE_ORDER = ["validate", "evidence", "log", "projection", "commit", "done"] as const;
type Phase = (typeof PHASE_ORDER)[number];

function resolveWorkDir(vault: string, workItem: string): Result<string> {
  const rel = normalizeWorkItemRel(workItem);
  const abs = join(vault, rel);
  if (!existsSync(abs)) {
    return err("FILE_NOT_FOUND", { path: rel });
  }
  if (!existsSync(join(abs, "spec.md"))) {
    return err("PREFLIGHT_FAILED", { reason: "missing-spec", path: rel });
  }
  return ok(abs);
}

function deriveOpId(vault: string, workItem: string): string {
  return operationId("skillwiki-work-complete-v1", [vault, workItem]);
}

function phaseIndex(phase: string): number {
  const i = PHASE_ORDER.indexOf(phase as Phase);
  return i < 0 ? 0 : i;
}

async function patchFrontmatterStatus(
  filePath: string,
  extraBody?: (body: string) => string,
): Promise<Result<{ changed: boolean; existed: boolean }>> {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error: unknown) {
    return err("WRITE_FAILED", { path: filePath, stage: "read", message: String(error) });
  }
  const split = splitFrontmatter(text);
  if (!split.ok || !split.data.rawFrontmatter) {
    if (extraBody) {
      return atomicWriteText(filePath, extraBody(text));
    }
    return ok({ changed: false, existed: true });
  }
  let fm = split.data.rawFrontmatter;
  if (/^status:\s*/m.test(fm)) {
    fm = fm.replace(/^status:\s*.*$/m, "status: completed");
  } else {
    fm = `status: completed\n${fm}`;
  }
  if (!/^completed:\s*/m.test(fm)) {
    fm = `completed: ${new Date().toISOString().slice(0, 10)}\n${fm}`;
  }
  let body = split.data.body;
  if (extraBody) body = extraBody(body);
  return atomicWriteText(filePath, `---\n${fm}\n---\n${body}`);
}

async function setStatusCompleted(filePath: string): Promise<Result<{ changed: boolean; existed: boolean }>> {
  return patchFrontmatterStatus(filePath);
}

async function writeEvidence(
  workDir: string,
  opId: string,
  phases: string[],
  writeText: typeof atomicWriteText,
): Promise<Result<{ changed: boolean; existed: boolean }>> {
  const path = join(workDir, "evidence.md");
  const body = [
    "---",
    "title: work-complete evidence",
    "status: completed",
    `operation_id: ${opId}`,
    "---",
    "",
    "# Work-complete evidence",
    "",
    `- operation_id: \`${opId}\``,
    `- phases: ${phases.join(", ")}`,
    `- completed_at: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  return writeText(path, body);
}

async function markPlanComplete(workDir: string): Promise<Result<{ changed: boolean; existed: boolean } | null>> {
  const planPath = join(workDir, "plan.md");
  if (!existsSync(planPath)) return ok(null);
  return patchFrontmatterStatus(planPath, (body) => body.replace(/- \[ \]/g, "- [x]"));
}

function writeFailure(stage: string, result: Result<unknown>): Run {
  return {
    exitCode: ExitCode.WRITE_FAILED,
    result: result.ok
      ? err("WRITE_FAILED", { stage, message: "unexpected ok" })
      : result,
  };
}

/**
 * Atomic work-item completion: validate → evidence → log → projection → commit.
 * Journaled by operation id so retries resume without double-commit or half state.
 */
export async function runWorkComplete(
  input: WorkCompleteInput,
  deps: WorkCompleteDeps = DEFAULT_DEPS,
): Promise<Run> {
  const workDirResult = resolveWorkDir(input.vault, input.workItem);
  if (!workDirResult.ok) {
    return {
      exitCode: workDirResult.error === "FILE_NOT_FOUND" ? ExitCode.FILE_NOT_FOUND : ExitCode.PREFLIGHT_FAILED,
      result: workDirResult,
    };
  }
  const workDir = workDirResult.data;
  const opId = input.operationId || deriveOpId(input.vault, input.workItem);
  if (!/^[0-9a-f]{64}$/.test(opId)) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "operationId must be SHA-256 hex" }) };
  }

  const journal = readWorkJournal(input.vault, opId) || {
    operation_id: opId,
    phase: "validate",
    retry_count: "0",
    work_item: input.workItem,
  };
  const startPhase = journal.phase || "validate";
  if (startPhase === "done") {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        operation_id: opId,
        work_item: input.workItem,
        phases: ["done"],
        completed: true,
        retried: true,
        committed: journal.committed === "true",
        humanHint: `work-complete already finished (${opId.slice(0, 12)})`,
      }),
    };
  }

  const completedPhases: string[] = [];
  let phase: Phase = PHASE_ORDER.includes(startPhase as Phase) ? (startPhase as Phase) : "validate";
  const retried = Number(journal.retry_count || "0") > 0;

  const advance = (next: Phase, extra: Record<string, string> = {}) => {
    phase = next;
    writeWorkJournal(input.vault, opId, {
      ...journal,
      operation_id: opId,
      phase: next,
      work_item: input.workItem,
      retry_count: journal.retry_count || "0",
      ...extra,
    });
    Object.assign(journal, { phase: next, ...extra });
    completedPhases.push(next);
  };

  if (phaseIndex(startPhase) > 0) {
    journal.retry_count = String(Number(journal.retry_count || "0") + 1);
  }
  writeWorkJournal(input.vault, opId, {
    ...journal,
    operation_id: opId,
    phase: startPhase,
    work_item: input.workItem,
  });

  try {
    if (phaseIndex(phase) <= phaseIndex("validate")) {
      const cross = await runWorkValidate({ vault: input.vault, workItem: input.workItem, requireComplete: false });
      if (!cross.result.ok || cross.exitCode !== ExitCode.OK) {
        return {
          exitCode: cross.exitCode || ExitCode.PREFLIGHT_FAILED,
          result: err("PREFLIGHT_FAILED", {
            reason: "work-validate-failed",
            detail: cross.result.ok ? cross.result.data : cross.result,
          }),
        };
      }
      if (input.failAfter === "validate") {
        throw new Error("simulated failure after validate");
      }
      advance("evidence");
    }

    if (phaseIndex(phase) <= phaseIndex("evidence")) {
      const statusWrite = await setStatusCompleted(join(workDir, "spec.md"));
      if (!statusWrite.ok) return writeFailure("evidence-spec", statusWrite);
      const planWrite = await markPlanComplete(workDir);
      if (!planWrite.ok) return writeFailure("evidence-plan", planWrite);
      const evidenceWrite = await writeEvidence(
        workDir,
        opId,
        completedPhases,
        deps.writeEvidenceText,
      );
      if (!evidenceWrite.ok) return writeFailure("evidence", evidenceWrite);
      if (input.failAfter === "evidence") {
        throw new Error("simulated failure after evidence");
      }
      advance("log");
    }

    if (phaseIndex(phase) <= phaseIndex("log")) {
      const date = new Date().toISOString().slice(0, 10);
      const log = await runLogAppend({
        vault: input.vault,
        content: `## [${date}] work-complete | ${input.workItem}\n\n- operation_id: ${opId}`,
        operationId: opId,
        writeEvent: true,
        eventKind: "work-complete",
        eventTarget: input.workItem,
        eventNote: `work-complete ${input.workItem}`,
        recordLastOp: false,
      });
      if (!log.result.ok) {
        return { exitCode: log.exitCode, result: log.result };
      }
      if (input.failAfter === "log") {
        throw new Error("simulated failure after log");
      }
      advance("projection");
    }

    if (phaseIndex(phase) <= phaseIndex("projection")) {
      // Ensure evidence exists (resume safety) and cross-validate complete.
      if (!existsSync(join(workDir, "evidence.md"))) {
        const evidenceWrite = await writeEvidence(
          workDir,
          opId,
          completedPhases,
          deps.writeEvidenceText,
        );
        if (!evidenceWrite.ok) return writeFailure("projection-evidence", evidenceWrite);
      }
      const finalCheck = await runWorkValidate({
        vault: input.vault,
        workItem: input.workItem,
        requireComplete: true,
      });
      if (!finalCheck.result.ok || (finalCheck.result.ok && !finalCheck.result.data.valid)) {
        return {
          exitCode: ExitCode.PREFLIGHT_FAILED,
          result: err("PREFLIGHT_FAILED", {
            reason: "completion-validation-failed",
            detail: finalCheck.result.ok ? finalCheck.result.data : finalCheck.result,
          }),
        };
      }
      if (input.failAfter === "projection") {
        throw new Error("simulated failure after projection");
      }
      advance("commit");
    }

    let committed = false;
    if (phaseIndex(phase) <= phaseIndex("commit")) {
      if (!input.noCommit && existsSync(join(input.vault, ".git"))) {
        try {
          appendLastOp(input.vault, {
            operation: "work-complete",
            summary: `completed ${input.workItem}`,
            files: [input.workItem],
            timestamp: new Date().toISOString(),
          });
          git(input.vault, ["add", "--", input.workItem, "log.md", "meta/log-events"]);
          const porcelain = git(input.vault, ["status", "--porcelain"]);
          if (porcelain && porcelain.trim()) {
            gitStrict(input.vault, ["commit", "-m", `work-complete: ${input.workItem} (${opId.slice(0, 12)})`]);
            committed = true;
          }
        } catch (e: unknown) {
          return {
            exitCode: ExitCode.WRITE_FAILED,
            result: err("WRITE_FAILED", { stage: "commit", message: String(e) }),
          };
        }
      }
      if (input.failAfter === "commit") {
        throw new Error("simulated failure after commit");
      }
      advance("done", { committed: committed ? "true" : "false" });
    }

    return {
      exitCode: ExitCode.OK,
      result: ok({
        operation_id: opId,
        work_item: input.workItem,
        phases: completedPhases,
        completed: true,
        retried,
        committed,
        humanHint: `work-complete finished ${input.workItem} (${opId.slice(0, 12)})`,
      }),
    };
  } catch (error: unknown) {
    writeWorkJournal(input.vault, opId, {
      ...journal,
      operation_id: opId,
      phase,
      work_item: input.workItem,
      retry_count: String(Number(journal.retry_count || "0") + 1),
      reason: String(error),
    });
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", {
        stage: phase,
        message: String(error),
        operation_id: opId,
        resumable: true,
      }),
    };
  }
}
