/**
 * Managed Layer-3 architecture publisher:
 * skillwiki project-page publish <draft> [vault] --project <slug> --target <path>
 *
 * Durable order:
 * freeze draft → validate → approval → preflight → lock → revalidate → journal
 * → taxonomy → page → verify → project-index → unlock → event → log → cleanup
 *
 * Never mutates root index.md. Regenerates projects/{slug}/knowledge.md.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { err, ok, ExitCode, type ErrResult, type Result } from "@skillwiki/shared";
import { runLogAppend } from "./log-append.js";
import { renderProjectIndex } from "./project-index.js";
import { extractTaxonomy, reconcileTaxonomyDocument, taxonomyCommentForPage } from "../parsers/taxonomy.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import {
  assertArchitectureTargetInsideVault,
  prepareArchitecturePage,
  type PreparedArchitecturePage,
} from "../utils/architecture-page.js";
import { git } from "../utils/git.js";
import {
  runManagedWritePreflight,
  runManagedWriteTransaction,
  type ManagedWritePreflightInput,
  type ManagedWriteReceipt,
  type ManagedWriteMode,
} from "../utils/managed-write-preflight.js";
import { writeLogEvent } from "../utils/log-events.js";
import {
  advancePublicationJournal,
  buildIdentitySummary,
  completePublicationJournal,
  createPublicationJournal,
  isValidPhase,
  readPublicationJournal,
  type PublicationIdentitySummary,
  type PublicationPhase,
} from "../utils/publication-operation-journal.js";
import {
  buildApprovalPayload,
  encodeApprovalToken,
  normalizeLogNote,
  operationIdFromApproval,
  redactApprovalTokens,
  sha256Hex,
  verifyApprovalToken,
  type ApprovalPayload,
} from "../utils/publication-approval.js";
import { resolveRootAggregateMode } from "./page-publish.js";
import { redactSensitiveContent, scanSensitiveContent } from "../utils/sensitive-content.js";
import { safeWritePage } from "../utils/safe-write.js";
import { acquireOwnedSyncLock, releaseOwnedSyncLock } from "../utils/sync-lock.js";

export interface ProjectPagePublishInput {
  vault: string;
  draftPath: string;
  project: string;
  target: string;
  logNote?: string;
  write: boolean;
  approve?: string;
  now?: Date;
  /** Test-only home override for publication journals. */
  journalHome?: string;
}

export interface ProjectPagePublishOutput {
  approval_required: boolean;
  approval_token?: string;
  operation_id: string;
  project: string;
  target: string;
  page_type: string;
  tags: string[];
  taxonomy_added: string[];
  page_changed: boolean;
  project_index_changed: boolean;
  log_appended: boolean;
  dry_run: boolean;
  files_changed: string[];
  draft_sha256: string;
  target_before: string;
  base_oid: string | null;
  write_mode: ManagedWriteMode | null;
  mutation_vault?: string;
  git_vault?: string | null;
  convergence_vault?: string;
  convergence_source?: ManagedWriteReceipt["convergence_source"];
  host_id?: string;
  humanHint: string;
}

export type ProjectPublishStage =
  | "journal"
  | "taxonomy"
  | "page"
  | "verify"
  | "project-index"
  | "unlock"
  | "event"
  | "log"
  | "journal-cleanup";

export interface ProjectPagePublishDeps {
  afterStage(stage: ProjectPublishStage): Promise<void>;
  preflight(
    input: ManagedWritePreflightInput,
  ): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }>;
}

export type ProjectPagePublishRun = { exitCode: number; result: Result<ProjectPagePublishOutput> };

const DEFAULT_DEPS: ProjectPagePublishDeps = {
  afterStage: async () => undefined,
  preflight: (input) => runManagedWritePreflight(input),
};

/** Test-only hook factory. */
export function defaultProjectPagePublishDeps(
  overrides: Partial<ProjectPagePublishDeps> = {},
): ProjectPagePublishDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

export interface PreparedProjectPagePublication {
  page: PreparedArchitecturePage;
  source: { kind: "file"; realPath: string } | { kind: "content" };
  targetPath: string;
  logNote: string;
  draftSha256: string;
  priorTargetSha256: string;
  approvalPayload: ApprovalPayload;
  operationId: string;
  identity: PublicationIdentitySummary;
  date: string;
  taxonomyComment: string;
}

function errorExitCode(error: string): number {
  switch (error) {
    case "FILE_NOT_FOUND":
      return ExitCode.FILE_NOT_FOUND;
    case "MISSING_CLOSING_DELIMITER":
      return ExitCode.MISSING_CLOSING_DELIMITER;
    case "SCHEME_REJECTED":
    case "NO_TAXONOMY_BLOCK":
      return ExitCode.SCHEME_REJECTED;
    case "VAULT_PATH_INVALID":
      return ExitCode.VAULT_PATH_INVALID;
    case "SENSITIVE_CONTENT_DETECTED":
      return ExitCode.SENSITIVE_CONTENT_DETECTED;
    case "SYNC_LOCK_HELD":
      return ExitCode.SYNC_LOCK_HELD;
    case "PREFLIGHT_FAILED":
      return ExitCode.PREFLIGHT_FAILED;
    case "APPROVAL_REQUIRED":
      return ExitCode.APPROVAL_REQUIRED;
    case "APPROVAL_INVALID":
      return ExitCode.APPROVAL_INVALID;
    case "APPROVAL_MISMATCH":
      return ExitCode.APPROVAL_MISMATCH;
    case "TARGET_DRIFT":
      return ExitCode.TARGET_DRIFT;
    case "RECOVERY_EVIDENCE_MISSING":
      return ExitCode.RECOVERY_EVIDENCE_MISSING;
    case "PROJECT_NOT_FOUND":
      return ExitCode.PROJECT_NOT_FOUND;
    case "USAGE":
      return ExitCode.USAGE;
    case "EVENT_IDENTITY_COLLISION":
    case "WRITE_FAILED":
      return ExitCode.WRITE_FAILED;
    default:
      return ExitCode.INVALID_FRONTMATTER;
  }
}

function redactDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  try {
    const encoded = JSON.stringify(detail);
    const redacted = redactApprovalTokens(redactSensitiveContent(encoded).text);
    return JSON.parse(redacted);
  } catch {
    return { message: "unserializable error detail omitted" };
  }
}

async function observeStage(
  deps: ProjectPagePublishDeps,
  stage: ProjectPublishStage,
): Promise<ErrResult | undefined> {
  try {
    await deps.afterStage(stage);
    return undefined;
  } catch (error: unknown) {
    return err("WRITE_FAILED", {
      message: redactApprovalTokens(`stage hook failed at ${stage}: ${String(error)}`),
    });
  }
}

async function readPriorTargetSha(targetPath: string): Promise<Result<string>> {
  try {
    const text = await readFile(targetPath, "utf8");
    return ok(sha256Hex(text));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok("absent");
    return err("WRITE_FAILED", { path: targetPath, message: String(error) });
  }
}

function validateLogNote(logNote: string | undefined): Result<string> {
  if (logNote !== undefined && /[\r\n]/.test(logNote)) {
    return err("SCHEME_REJECTED", { message: "log note must be one line" });
  }
  const normalized = normalizeLogNote(logNote);
  if (normalized && Buffer.byteLength(normalized, "utf8") > 500) {
    return err("SCHEME_REJECTED", { message: "log note must be one line and at most 500 UTF-8 bytes" });
  }
  if (normalized && scanSensitiveContent(normalized, { file: "project-page-publish log note" }).length > 0) {
    return err("SENSITIVE_CONTENT_DETECTED", {
      message: "log note contains sensitive authentication material",
    });
  }
  return ok(normalized);
}

/** Freeze draft bytes and compute approval identity (no vault mutation). */
export async function prepareProjectPagePublication(
  input: ProjectPagePublishInput,
): Promise<Result<PreparedProjectPagePublication>> {
  let content: string;
  try {
    content = await readFile(input.draftPath, "utf8");
  } catch (error: unknown) {
    return err("FILE_NOT_FOUND", { path: input.draftPath, message: String(error) });
  }

  let draftRealPath: string;
  try {
    draftRealPath = realpathSync(input.draftPath);
  } catch (error: unknown) {
    return err("VAULT_PATH_INVALID", {
      path: input.draftPath,
      message: `draft realpath failed: ${String(error)}`,
    });
  }

  const target = assertArchitectureTargetInsideVault(input.vault, input.target, input.project);
  if (!target.ok) return target;
  if (
    resolve(input.draftPath) === target.data.absolutePath ||
    (target.data.existingRealPath !== undefined && draftRealPath === target.data.existingRealPath)
  ) {
    return err("VAULT_PATH_INVALID", { message: "draft must not alias the final target" });
  }

  const isNew = target.data.existingRealPath === undefined;
  const page = prepareArchitecturePage(content, input.target, input.project, { isNew });
  if (!page.ok) return page;

  const logNote = validateLogNote(input.logNote);
  if (!logNote.ok) return logNote;

  const prior = await readPriorTargetSha(target.data.absolutePath);
  if (!prior.ok) return prior;

  const draftSha256 = sha256Hex(content);
  const approvalPayload = buildApprovalPayload({
    publisher: "project-page",
    draft_sha256: draftSha256,
    target: input.target,
    project: input.project,
    log_note: logNote.data,
    prior_target_sha256: prior.data,
  });
  if (!approvalPayload.ok) return approvalPayload;

  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const taxonomyComment = taxonomyCommentForPage(input.target, date);
  if (!taxonomyComment.ok) return taxonomyComment;

  const identity = buildIdentitySummary({
    publisher: "project-page",
    draft_sha256: draftSha256,
    target: input.target,
    project: input.project,
    log_note: logNote.data,
    prior_target_sha256: prior.data,
  });

  return ok({
    page: page.data,
    source: { kind: "file", realPath: draftRealPath },
    targetPath: target.data.absolutePath,
    logNote: logNote.data,
    draftSha256,
    priorTargetSha256: prior.data,
    approvalPayload: approvalPayload.data,
    operationId: operationIdFromApproval(approvalPayload.data),
    identity,
    date,
    taxonomyComment: taxonomyComment.data,
  });
}

function successReceipt(
  prepared: PreparedProjectPagePublication,
  opts: {
    taxonomyAdded: string[];
    pageChanged: boolean;
    projectIndexChanged: boolean;
    logAppended: boolean;
    filesChanged: string[];
    dryRun: boolean;
    approvalToken?: string;
    receipt?: ManagedWriteReceipt | null;
  },
): ProjectPagePublishRun {
  return {
    exitCode: ExitCode.OK,
    result: ok({
      approval_required: true,
      ...(opts.approvalToken ? { approval_token: opts.approvalToken } : {}),
      operation_id: prepared.operationId,
      project: prepared.page.project,
      target: prepared.page.target,
      page_type: prepared.page.type,
      tags: [...prepared.page.tags],
      taxonomy_added: [...opts.taxonomyAdded],
      page_changed: opts.pageChanged,
      project_index_changed: opts.projectIndexChanged,
      log_appended: opts.logAppended,
      dry_run: opts.dryRun,
      files_changed: opts.filesChanged,
      draft_sha256: prepared.draftSha256,
      target_before: prepared.priorTargetSha256,
      base_oid: opts.receipt?.base_oid ?? null,
      write_mode: opts.receipt?.mode ?? null,
      ...(opts.receipt
        ? {
            mutation_vault: opts.receipt.mutation_vault,
            git_vault: opts.receipt.git_vault,
            convergence_source: opts.receipt.convergence_source,
          }
        : {}),
      ...(opts.receipt?.convergence_vault
        ? { convergence_vault: opts.receipt.convergence_vault }
        : {}),
      ...(opts.receipt?.host_id ? { host_id: opts.receipt.host_id } : {}),
      humanHint: opts.dryRun
        ? `dry run: would publish ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`
        : `published ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`,
    }),
  };
}

function phaseFailure(
  stage: string,
  prepared: PreparedProjectPagePublication,
  published: boolean,
  verified: boolean,
  cause: ErrResult,
  context: Record<string, unknown> = {},
  exitCode: number = ExitCode.WRITE_FAILED,
): ProjectPagePublishRun {
  return {
    exitCode: exitCode === ExitCode.WRITE_FAILED ? errorExitCode(cause.error) || ExitCode.WRITE_FAILED : exitCode,
    result: err(cause.error === "EVENT_IDENTITY_COLLISION" ? "WRITE_FAILED" : cause.error, {
      ...context,
      stage,
      published,
      verified,
      target: prepared.page.target,
      operation_id: prepared.operationId,
      retry_safe: stage !== "target" && cause.error !== "TARGET_DRIFT",
      cause_error: cause.error,
      cause_detail: redactDetail(cause.detail),
    }),
  };
}

async function previewProjectPagePublication(
  prepared: PreparedProjectPagePublication,
  vault: string,
): Promise<ProjectPagePublishRun> {
  const schemaPath = join(vault, "SCHEMA.md");
  let schemaText: string;
  try {
    schemaText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: schemaPath, message: String(error) }),
    };
  }
  const reconciled = reconcileTaxonomyDocument(schemaText, {
    tags: prepared.page.tags,
    comment: prepared.taxonomyComment,
  });
  if (!reconciled.ok) return { exitCode: errorExitCode(reconciled.error), result: reconciled };

  const prior = await readPriorTargetSha(prepared.targetPath);
  if (!prior.ok) return { exitCode: errorExitCode(prior.error), result: prior };
  const pageChanged = prior.data === "absent" || prior.data !== prepared.draftSha256;

  const projectIndex = await renderProjectIndex(vault, prepared.page.project, { today: prepared.date });
  if (!projectIndex.ok) {
    // Project may lack knowledge.md yet; still treat as changed if project exists after page write.
    if (projectIndex.error !== "PROJECT_NOT_FOUND") {
      return { exitCode: errorExitCode(projectIndex.error), result: projectIndex };
    }
  }

  let projectIndexChanged = true;
  if (projectIndex.ok) {
    const indexPath = join(vault, projectIndex.data.index_path);
    try {
      const existing = await readFile(indexPath, "utf8");
      // After publication the page would be present; compare against rendered-with-current-fs.
      projectIndexChanged = existing !== projectIndex.data.text || pageChanged;
    } catch {
      projectIndexChanged = true;
    }
  }

  const logPath = join(vault, "log.md");
  let logAppended = true;
  try {
    const logText = await readFile(logPath, "utf8");
    logAppended = !logText.includes(`<!-- skillwiki-project-page-publish:${prepared.operationId} -->`);
  } catch {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { path: logPath }),
    };
  }

  const token = encodeApprovalToken(prepared.approvalPayload);
  if (!token.ok) return { exitCode: errorExitCode(token.error), result: token };

  const filesChanged = [
    ...(reconciled.data.changed ? ["SCHEMA.md"] : []),
    ...(pageChanged ? [prepared.page.target] : []),
    ...(projectIndexChanged ? [`projects/${prepared.page.project}/knowledge.md`] : []),
    ...(logAppended ? ["log.md"] : []),
  ];

  return successReceipt(prepared, {
    taxonomyAdded: reconciled.data.added,
    pageChanged,
    projectIndexChanged,
    logAppended,
    filesChanged,
    dryRun: true,
    approvalToken: token.data,
  });
}

interface LockedState {
  taxonomyAdded: string[];
  pageChanged: boolean;
  projectIndexChanged: boolean;
  published: boolean;
  verified: boolean;
  changed: Set<string>;
}

function emptyLockedState(): LockedState {
  return {
    taxonomyAdded: [],
    pageChanged: false,
    projectIndexChanged: false,
    published: false,
    verified: false,
    changed: new Set<string>(),
  };
}

async function revalidatePriorUnderLock(
  prepared: PreparedProjectPagePublication,
  vault: string,
): Promise<Result<{ absolutePath: string }>> {
  const fresh = assertArchitectureTargetInsideVault(vault, prepared.page.target, prepared.page.project);
  if (!fresh.ok) return fresh;
  if (fresh.data.absolutePath !== prepared.targetPath) {
    return err("VAULT_PATH_INVALID", { message: "target canonical path changed after preparation" });
  }
  if (
    prepared.source.kind === "file" &&
    fresh.data.existingRealPath !== undefined &&
    fresh.data.existingRealPath === prepared.source.realPath
  ) {
    return err("VAULT_PATH_INVALID", { message: "draft now aliases the final target" });
  }
  const prior = await readPriorTargetSha(fresh.data.absolutePath);
  if (!prior.ok) return prior;
  if (prior.data !== prepared.priorTargetSha256) {
    // Idempotent resume: target already equals approved draft.
    if (prior.data === prepared.draftSha256) {
      return ok({ absolutePath: fresh.data.absolutePath });
    }
    return err("TARGET_DRIFT", {
      message: "target changed since approval",
      expected_prior: prepared.priorTargetSha256,
      actual: prior.data,
    });
  }
  return ok({ absolutePath: fresh.data.absolutePath });
}

const PHASE_RANK: Record<PublicationPhase, number> = {
  locked: 0,
  taxonomy: 1,
  page: 2,
  verified: 3,
  "project-index": 4,
  unlocked: 5,
  event: 6,
  log: 7,
  complete: 8,
};

function phaseAtLeast(current: PublicationPhase | undefined, needed: PublicationPhase): boolean {
  if (!current || !isValidPhase(current)) return false;
  return PHASE_RANK[current] >= PHASE_RANK[needed];
}

async function runLockedStages(
  prepared: PreparedProjectPagePublication,
  vault: string,
  deps: ProjectPagePublishDeps,
  journalHome: string | undefined,
): Promise<
  | { ok: true; data: LockedState }
  | { ok: false; exitCode: number; stage: string; state: LockedState; cause: ErrResult }
> {
  const state = emptyLockedState();
  const home = journalHome;

  const revalidated = await revalidatePriorUnderLock(prepared, vault);
  if (!revalidated.ok) {
    return {
      ok: false,
      exitCode: errorExitCode(revalidated.error),
      stage: "target",
      state,
      cause: revalidated,
    };
  }

  // Journal after lock + revalidation, before first vault write.
  // Resume path: journal may already exist from a partial prior attempt.
  let currentPhase: PublicationPhase = "locked";
  const existingJournal = readPublicationJournal(vault, prepared.operationId, home);
  if (!existingJournal.ok) {
    return {
      ok: false,
      exitCode: errorExitCode(existingJournal.error),
      stage: "journal",
      state,
      cause: existingJournal,
    };
  }
  if (!existingJournal.data) {
    const journal = createPublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      home,
    });
    if (!journal.ok) {
      return {
        ok: false,
        exitCode: errorExitCode(journal.error),
        stage: "journal",
        state,
        cause: journal,
      };
    }
  } else {
    currentPhase = existingJournal.data.phase;
    state.published = existingJournal.data.published || phaseAtLeast(currentPhase, "page");
    state.verified = existingJournal.data.verified || phaseAtLeast(currentPhase, "verified");
    for (const f of existingJournal.data.files_changed) state.changed.add(f);
  }
  const journalHook = await observeStage(deps, "journal");
  if (journalHook) {
    return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "journal", state, cause: journalHook };
  }

  const schemaPath = join(vault, "SCHEMA.md");

  // Idempotent taxonomy reconcile even on resume (superset is harmless).
  {
    let schemaText: string;
    try {
      schemaText = await readFile(schemaPath, "utf8");
    } catch (error: unknown) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "taxonomy",
        state,
        cause: err("WRITE_FAILED", { message: String(error) }),
      };
    }
    const reconciled = reconcileTaxonomyDocument(schemaText, {
      tags: prepared.page.tags,
      comment: prepared.taxonomyComment,
    });
    if (!reconciled.ok) {
      return {
        ok: false,
        exitCode: errorExitCode(reconciled.error),
        stage: "taxonomy",
        state,
        cause: reconciled,
      };
    }
    state.taxonomyAdded = reconciled.data.added;
    if (reconciled.data.changed) {
      const schemaWrite = await atomicWriteText(schemaPath, reconciled.data.text);
      if (!schemaWrite.ok) {
        return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "taxonomy", state, cause: schemaWrite };
      }
      if (schemaWrite.data.changed) state.changed.add("SCHEMA.md");
    }
    if (!phaseAtLeast(currentPhase, "taxonomy")) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "taxonomy",
        filesChanged: [...state.changed],
        home,
      });
      currentPhase = "taxonomy";
    }
    const taxonomyHook = await observeStage(deps, "taxonomy");
    if (taxonomyHook) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "taxonomy", state, cause: taxonomyHook };
    }
  }

  if (!phaseAtLeast(currentPhase, "page")) {
    try {
      await mkdir(dirname(prepared.targetPath), { recursive: true });
    } catch (error: unknown) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "page",
        state,
        cause: err("WRITE_FAILED", { message: String(error) }),
      };
    }

    const pageWrite = await safeWritePage(prepared.targetPath, prepared.page.content);
    if (!pageWrite.ok) {
      return { ok: false, exitCode: errorExitCode(pageWrite.error), stage: "page", state, cause: pageWrite };
    }
    state.pageChanged = pageWrite.data.changed;
    if (state.pageChanged) state.changed.add(prepared.page.target);
    state.published = true;
    advancePublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      nextPhase: "page",
      published: true,
      filesChanged: [...state.changed],
      home,
    });
    currentPhase = "page";
    const pageHook = await observeStage(deps, "page");
    if (pageHook) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "page", state, cause: pageHook };
    }
  } else {
    state.published = true;
    // Still emit page stage hook for observability on resume? Prefer skip to avoid false progress.
  }

  if (!phaseAtLeast(currentPhase, "verified")) {
    let visible: string;
    let visibleSchema: string;
    try {
      [visible, visibleSchema] = await Promise.all([
        readFile(prepared.targetPath, "utf8"),
        readFile(schemaPath, "utf8"),
      ]);
    } catch (error: unknown) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "verify",
        state,
        cause: err("WRITE_FAILED", { message: String(error) }),
      };
    }
    const visiblePage = prepareArchitecturePage(visible, prepared.page.target, prepared.page.project, {
      isNew: false,
    });
    const visibleTaxonomy = extractTaxonomy(visibleSchema);
    if (
      !visiblePage.ok ||
      visible !== prepared.page.content ||
      sha256Hex(visible) !== prepared.draftSha256 ||
      !visibleTaxonomy.ok ||
      prepared.page.tags.some((tag) => !visibleTaxonomy.data.includes(tag))
    ) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "verify",
        state,
        cause: err("WRITE_FAILED", { message: "published bytes or taxonomy verification failed" }),
      };
    }
    state.verified = true;
    advancePublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      nextPhase: "verified",
      published: true,
      verified: true,
      filesChanged: [...state.changed],
      home,
    });
    currentPhase = "verified";
    const verifyHook = await observeStage(deps, "verify");
    if (verifyHook) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "verify", state, cause: verifyHook };
    }
  } else {
    state.verified = true;
  }

  if (!phaseAtLeast(currentPhase, "project-index")) {
    // Never touch root index.md — regenerate project knowledge.md only.
    const rendered = await renderProjectIndex(vault, prepared.page.project, { today: prepared.date });
    if (!rendered.ok) {
      return {
        ok: false,
        exitCode: errorExitCode(rendered.error),
        stage: "project-index",
        state,
        cause: rendered,
      };
    }
    const knowledgePath = join(vault, rendered.data.index_path);
    try {
      await mkdir(dirname(knowledgePath), { recursive: true });
    } catch (error: unknown) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "project-index",
        state,
        cause: err("WRITE_FAILED", { message: String(error) }),
      };
    }
    const knowledgeWrite = await atomicWriteText(knowledgePath, rendered.data.text);
    if (!knowledgeWrite.ok) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "project-index",
        state,
        cause: knowledgeWrite,
      };
    }
    state.projectIndexChanged = knowledgeWrite.data.changed;
    if (state.projectIndexChanged) state.changed.add(rendered.data.index_path);

    try {
      const visibleIndex = await readFile(knowledgePath, "utf8");
      if (visibleIndex !== rendered.data.text) {
        return {
          ok: false,
          exitCode: ExitCode.WRITE_FAILED,
          stage: "project-index",
          state,
          cause: err("WRITE_FAILED", { message: "project knowledge.md verification failed" }),
        };
      }
    } catch (error: unknown) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "project-index",
        state,
        cause: err("WRITE_FAILED", { message: String(error) }),
      };
    }
    advancePublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      nextPhase: "project-index",
      published: true,
      verified: true,
      filesChanged: [...state.changed],
      home,
    });
    currentPhase = "project-index";
    const indexHook = await observeStage(deps, "project-index");
    if (indexHook) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "project-index",
        state,
        cause: indexHook,
      };
    }
  }

  return { ok: true, data: state };
}

function renderProjectPublicationLog(prepared: PreparedProjectPagePublication, added: string[]): string {
  return [
    `## [${prepared.date}] project-page-publish | ${prepared.page.target}`,
    "",
    `- Published: [[${prepared.page.target.replace(/\.md$/, "")}]]`,
    `- Project: [[${prepared.page.project}]]`,
    `- Taxonomy: ${added.length > 0 ? `added ${added.join(", ")}` : "no additions"}`,
    ...(prepared.logNote ? [`- Note: ${prepared.logNote}`] : []),
  ].join("\n");
}

async function publishWithReceipt(
  prepared: PreparedProjectPagePublication,
  vault: string,
  writeReceipt: ManagedWriteReceipt,
  deps: ProjectPagePublishDeps,
  journalHome?: string,
): Promise<ProjectPagePublishRun> {
  const canonicalVault = resolve(vault);
  if (writeReceipt.mutation_vault !== canonicalVault) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: "mutation-vault-receipt-mismatch",
        expected: writeReceipt.mutation_vault,
        actual: canonicalVault,
      }),
    };
  }
  if (writeReceipt.base_oid) {
    // Managed dual-path: base OID from git/convergence vault, not FUSE mutation vault.
    const head = writeReceipt.git_vault
      ? git(writeReceipt.git_vault, ["rev-parse", "HEAD"])
      : null;
    if (head !== writeReceipt.base_oid) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "base-oid-drift",
          expected: writeReceipt.base_oid,
          actual: head,
          git_vault: writeReceipt.git_vault,
        }),
      };
    }
  }

  const aggregateMode = resolveRootAggregateMode();

  let lock: ReturnType<typeof acquireOwnedSyncLock>;
  try {
    lock = acquireOwnedSyncLock(vault, {
      summary: `project-page publish ${prepared.page.target}`,
      ttlMinutes: 1,
    });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "lock", message: String(error) }),
    };
  }
  if (!lock.ok) return { exitCode: errorExitCode(lock.error), result: lock };

  let primary: Awaited<ReturnType<typeof runLockedStages>> | undefined;
  let released: Result<{ released: boolean }> | undefined;
  try {
    primary = await runLockedStages(prepared, vault, deps, journalHome);
  } catch (error: unknown) {
    primary = {
      ok: false,
      exitCode: ExitCode.WRITE_FAILED,
      stage: "taxonomy",
      state: emptyLockedState(),
      cause: err("WRITE_FAILED", { message: `unexpected primary-stage failure: ${String(error)}` }),
    };
  } finally {
    released = releaseOwnedSyncLock(lock.data);
  }

  const primaryState = primary?.ok ? primary.data : primary?.state;
  if (released === undefined || !released.ok || !released.data.released) {
    return phaseFailure(
      "unlock",
      prepared,
      primaryState?.published ?? false,
      primaryState?.verified ?? false,
      released && !released.ok
        ? released
        : err("WRITE_FAILED", { message: "lock release did not run" }),
    );
  }
  {
    const journalNow = readPublicationJournal(vault, prepared.operationId, journalHome);
    const phase = journalNow.ok && journalNow.data ? journalNow.data.phase : undefined;
    if (!phaseAtLeast(phase, "unlocked")) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "unlocked",
        published: primaryState?.published,
        verified: primaryState?.verified,
        filesChanged: primaryState ? [...primaryState.changed] : undefined,
        home: journalHome,
      });
    }
  }
  const unlockHook = await observeStage(deps, "unlock");
  if (unlockHook) {
    return phaseFailure(
      "unlock",
      prepared,
      primaryState?.published ?? false,
      primaryState?.verified ?? false,
      unlockHook,
    );
  }

  if (primary === undefined) {
    return phaseFailure(
      "taxonomy",
      prepared,
      false,
      false,
      err("WRITE_FAILED", { message: "locked publication produced no result" }),
    );
  }
  if (!primary.ok) {
    return phaseFailure(
      primary.stage,
      prepared,
      primary.state.published,
      primary.state.verified,
      primary.cause,
      undefined,
      primary.exitCode,
    );
  }

  const state = primary.data;

  const event = await writeLogEvent(vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: prepared.operationId,
    occurred_at: `${prepared.date}T00:00:00.000Z`,
    host_id: writeReceipt.host_id ?? "standalone",
    actor: "skillwiki-cli",
    kind: "project-page-publish",
    target: prepared.page.target,
    note: prepared.logNote || `Published ${prepared.page.title}`,
    metadata: {
      page_type: prepared.page.type,
      project: prepared.page.project,
      tags: [...prepared.page.tags].sort(),
      draft_sha256: prepared.draftSha256,
      // Do not embed mutable base_oid in identity-critical fields; receipt still carries it.
    },
  });
  if (!event.ok) {
    return phaseFailure(
      "event",
      prepared,
      true,
      true,
      event,
      undefined,
      event.error === "EVENT_IDENTITY_COLLISION" ? ExitCode.WRITE_FAILED : errorExitCode(event.error),
    );
  }
  if (event.data.created) state.changed.add(event.data.path);
  {
    const journalNow = readPublicationJournal(vault, prepared.operationId, journalHome);
    const phase = journalNow.ok && journalNow.data ? journalNow.data.phase : undefined;
    if (!phaseAtLeast(phase, "event")) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "event",
        published: true,
        verified: true,
        filesChanged: [...state.changed],
        home: journalHome,
      });
    }
  }
  const eventHook = await observeStage(deps, "event");
  if (eventHook) return phaseFailure("event", prepared, true, true, eventHook);

  let logAppended = false;
  if (aggregateMode === "dual") {
    const log = await runLogAppend({
      vault,
      content: renderProjectPublicationLog(prepared, state.taxonomyAdded),
      operationId: prepared.operationId,
      strictLock: true,
      recordLastOp: false,
      eventKind: "project-page-publish",
    });
    if (!log.result.ok) return phaseFailure("log", prepared, true, true, log.result);
    if (log.exitCode !== ExitCode.OK) {
      return phaseFailure(
        "log",
        prepared,
        true,
        true,
        err("WRITE_FAILED", { message: "log append returned inconsistent success state" }),
      );
    }
    logAppended = log.result.data.appended;
    if (logAppended) state.changed.add("log.md");
    {
      const journalNow = readPublicationJournal(vault, prepared.operationId, journalHome);
      const phase = journalNow.ok && journalNow.data ? journalNow.data.phase : undefined;
      if (!phaseAtLeast(phase, "log")) {
        advancePublicationJournal({
          vaultPath: vault,
          operationId: prepared.operationId,
          identity: prepared.identity,
          nextPhase: "log",
          published: true,
          verified: true,
          filesChanged: [...state.changed],
          home: journalHome,
        });
      }
    }
    const logHook = await observeStage(deps, "log");
    if (logHook) return phaseFailure("log", prepared, true, true, logHook);
  }

  const completed = completePublicationJournal({
    vaultPath: vault,
    operationId: prepared.operationId,
    identity: prepared.identity,
    filesChanged: [...state.changed],
    home: journalHome,
  });
  if (!completed.ok) {
    // Journal may already be gone after a prior complete; treat missing as success if event exists.
    if (completed.error !== "RECOVERY_EVIDENCE_MISSING") {
      return phaseFailure("journal-cleanup", prepared, true, true, completed);
    }
  }
  const cleanupHook = await observeStage(deps, "journal-cleanup");
  if (cleanupHook) return phaseFailure("journal-cleanup", prepared, true, true, cleanupHook);

  return successReceipt(prepared, {
    taxonomyAdded: state.taxonomyAdded,
    pageChanged: state.pageChanged,
    projectIndexChanged: state.projectIndexChanged,
    logAppended,
    filesChanged: [...state.changed],
    dryRun: false,
    receipt: writeReceipt,
  });
}

async function publishPrepared(
  prepared: PreparedProjectPagePublication,
  vault: string,
  deps: ProjectPagePublishDeps,
  journalHome?: string,
): Promise<ProjectPagePublishRun> {
  return runManagedWriteTransaction({
    vault,
    command: `project-page publish ${prepared.page.target}`,
    allowImmutableRecord: true,
    preflight: deps.preflight,
    mutate: async (receipt) => publishWithReceipt(prepared, vault, receipt, deps, journalHome),
  });
}

/** File-based command entry point for `project-page publish`. */
export async function runProjectPagePublish(
  input: ProjectPagePublishInput,
  deps: ProjectPagePublishDeps = DEFAULT_DEPS,
): Promise<ProjectPagePublishRun> {
  if (input.approve && !input.write) {
    return {
      exitCode: ExitCode.USAGE,
      result: err("USAGE", { message: "--approve requires --write" }),
    };
  }
  if (input.write && !input.approve) {
    return {
      exitCode: ExitCode.APPROVAL_REQUIRED,
      result: err("APPROVAL_REQUIRED", {
        message: "project-page publish --write requires --approve <token> from a prior dry-run",
        project: input.project,
        target: input.target,
      }),
    };
  }

  const prepared = await prepareProjectPagePublication(input);
  if (!prepared.ok) return { exitCode: errorExitCode(prepared.error), result: prepared };

  if (!input.write) {
    return previewProjectPagePublication(prepared.data, input.vault);
  }

  // Validate approval before preflight/lock/journal/write.
  const verified = verifyApprovalToken(input.approve!, {
    publisher: "project-page",
    draft_sha256: prepared.data.draftSha256,
    target: prepared.data.page.target,
    project: prepared.data.page.project,
    log_note: prepared.data.logNote,
    prior_target_sha256: prepared.data.priorTargetSha256,
  });
  if (!verified.ok) {
    return {
      exitCode: errorExitCode(verified.error),
      result: err(verified.error, redactDetail(verified.detail)),
    };
  }

  return publishPrepared(prepared.data, input.vault, deps, input.journalHome);
}

// Silence unused import if phase type only used internally via string unions
void (null as unknown as PublicationPhase);
