import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { err, ok, ExitCode, type ErrResult, type Result } from "@skillwiki/shared";
import { runLogAppend } from "./log-append.js";
import { extractTaxonomy, reconcileTaxonomyDocument, taxonomyCommentForPage } from "../parsers/taxonomy.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { git } from "../utils/git.js";
import { upsertIndexEntry, renderIndexUpsert } from "../utils/index-entry.js";
import {
  runManagedWritePreflight,
  runManagedWriteTransaction,
  type ManagedWritePreflightInput,
  type ManagedWriteReceipt,
  type ManagedWriteMode,
} from "../utils/managed-write-preflight.js";
import { writeLogEvent } from "../utils/log-events.js";
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
import { redactSensitiveContent, scanSensitiveContent } from "../utils/sensitive-content.js";
import { safeWritePage } from "../utils/safe-write.js";
import { acquireOwnedSyncLock, releaseOwnedSyncLock } from "../utils/sync-lock.js";
import {
  assertTargetInsideVault,
  prepareTypedPage,
  type PreparedTypedPage,
} from "../utils/typed-page.js";

export interface PagePublishInput {
  vault: string;
  draftPath: string;
  target: string;
  logNote?: string;
  write: boolean;
  /** Optional target-bound approval token from a prior dry-run. */
  approve?: string;
  now?: Date;
}

export interface PagePublicationContentInput {
  vault: string;
  content: string;
  target: string;
  logNote?: string;
  now?: Date;
  /** Prior target SHA-256 or "absent"; computed automatically when omitted. */
  priorTargetSha256?: string;
}

export interface PagePublishOutput {
  target: string;
  page_type: string;
  tags: string[];
  taxonomy_added: string[];
  page_changed: boolean;
  index_updated: boolean;
  log_appended: boolean;
  operation_id: string;
  dry_run: boolean;
  files_changed: string[];
  base_oid: string | null;
  write_mode: ManagedWriteMode | null;
  approval_token?: string;
  draft_sha256?: string;
  target_before?: string;
  mutation_vault?: string;
  git_vault?: string | null;
  convergence_vault?: string;
  convergence_source?: ManagedWriteReceipt["convergence_source"];
  host_id?: string;
  humanHint: string;
}

export interface PreparedPagePublication {
  page: PreparedTypedPage;
  source:
    | { kind: "file"; realPath: string }
    | { kind: "content" };
  targetPath: string;
  logNote?: string;
  operationId: string;
  date: string;
  taxonomyComment: string;
  draftSha256: string;
  priorTargetSha256: string;
  approvalPayload: ApprovalPayload;
}

export type PublishStage = "schema" | "page" | "verify" | "event" | "index" | "unlock" | "log";

export interface PagePublishDeps {
  afterStage(stage: PublishStage): Promise<void>;
  preflight(
    input: ManagedWritePreflightInput,
  ): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }>;
}

export type PagePublishRun = { exitCode: number; result: Result<PagePublishOutput> };

const DEFAULT_DEPS: PagePublishDeps = {
  afterStage: async () => undefined,
  preflight: (input) => runManagedWritePreflight(input),
};

/** Test-only hook factory; production callers use the immutable default dependency. */
export function defaultPagePublishDeps(overrides: Partial<PagePublishDeps> = {}): PagePublishDeps {
  return { ...DEFAULT_DEPS, ...overrides };
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
    case "USAGE":
      return ExitCode.USAGE;
    case "EVENT_IDENTITY_COLLISION":
    case "WRITE_FAILED":
      return ExitCode.WRITE_FAILED;
    default:
      return ExitCode.INVALID_FRONTMATTER;
  }
}

export type RootAggregateMode = "dual" | "source-only";

export function resolveRootAggregateMode(env: Record<string, string | undefined> = process.env): RootAggregateMode {
  // Explicit source-only for event-first hosts; dual remains the compatibility default
  // until the attended canary cuts over via SKILLWIKI_ROOT_AGGREGATE_MODE=source-only.
  if (env.SKILLWIKI_ROOT_AGGREGATE_MODE === "source-only") return "source-only";
  return "dual";
}

function prepareFrozenPublication(
  input: PagePublicationContentInput,
  source: PreparedPagePublication["source"],
): Result<PreparedPagePublication> {
  const target = assertTargetInsideVault(input.vault, input.target);
  if (!target.ok) return target;

  const page = prepareTypedPage(input.content, input.target);
  if (!page.ok) return page;

  if (input.logNote !== undefined && /[\r\n]/.test(input.logNote)) {
    return err("SCHEME_REJECTED", { message: "log note must be one line" });
  }
  const logNote = normalizeLogNote(input.logNote) || undefined;
  if (logNote && Buffer.byteLength(logNote, "utf8") > 500) {
    return err("SCHEME_REJECTED", { message: "log note must be one line and at most 500 UTF-8 bytes" });
  }
  if (logNote && scanSensitiveContent(logNote, { file: "page-publish log note" }).length > 0) {
    return err("SENSITIVE_CONTENT_DETECTED", { message: "log note contains sensitive authentication material" });
  }

  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const taxonomyComment = taxonomyCommentForPage(input.target, date);
  if (!taxonomyComment.ok) return taxonomyComment;

  const draftSha256 = sha256Hex(input.content);
  let priorTargetSha256 = input.priorTargetSha256;
  if (priorTargetSha256 === undefined) {
    try {
      const existing = readFileSync(target.data.absolutePath, "utf8");
      priorTargetSha256 = sha256Hex(existing);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") priorTargetSha256 = "absent";
      else {
        return err("WRITE_FAILED", {
          path: target.data.absolutePath,
          message: String(error),
        });
      }
    }
  }

  const approvalPayload = buildApprovalPayload({
    publisher: "page",
    draft_sha256: draftSha256,
    target: input.target,
    log_note: logNote ?? "",
    prior_target_sha256: priorTargetSha256,
  });
  if (!approvalPayload.ok) return approvalPayload;

  return ok({
    page: page.data,
    source,
    targetPath: target.data.absolutePath,
    logNote,
    operationId: operationIdFromApproval(approvalPayload.data),
    date,
    taxonomyComment: taxonomyComment.data,
    draftSha256,
    priorTargetSha256,
    approvalPayload: approvalPayload.data,
  });
}

/** Prepare exact, validated in-memory page bytes for a later preview or publication. */
export function preparePagePublicationFromContent(
  input: PagePublicationContentInput,
): Result<PreparedPagePublication> {
  return prepareFrozenPublication(input, { kind: "content" });
}

/** Read a draft once and freeze the exact validated bytes for a later publication. */
export async function preparePagePublication(
  input: PagePublishInput,
): Promise<Result<PreparedPagePublication>> {
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

  const target = assertTargetInsideVault(input.vault, input.target);
  if (!target.ok) return target;
  if (
    resolve(input.draftPath) === target.data.absolutePath ||
    (target.data.existingRealPath !== undefined && draftRealPath === target.data.existingRealPath)
  ) {
    return err("VAULT_PATH_INVALID", { message: "draft must not alias the final target" });
  }

  return prepareFrozenPublication(
    {
      vault: input.vault,
      content,
      target: input.target,
      logNote: input.logNote,
      now: input.now,
    },
    { kind: "file", realPath: draftRealPath },
  );
}

interface LockedPublicationState {
  taxonomyAdded: string[];
  pageChanged: boolean;
  indexUpdated: boolean;
  published: boolean;
  changed: Set<string>;
}

type LockedPublicationOutcome =
  | { ok: true; data: LockedPublicationState }
  | {
      ok: false;
      exitCode: number;
      stage: "target" | "schema" | "page" | "verify" | "index";
      state: LockedPublicationState;
      cause: ErrResult;
    };

function emptyLockedState(): LockedPublicationState {
  return {
    taxonomyAdded: [],
    pageChanged: false,
    indexUpdated: false,
    published: false,
    changed: new Set<string>(),
  };
}

function lockedFailure(
  stage: Exclude<LockedPublicationOutcome, { ok: true }> ["stage"],
  state: LockedPublicationState,
  cause: ErrResult,
  exitCode: number = ExitCode.WRITE_FAILED,
): LockedPublicationOutcome {
  return { ok: false, exitCode, stage, state, cause };
}

async function observeStage(
  deps: PagePublishDeps,
  stage: PublishStage,
): Promise<ErrResult | undefined> {
  try {
    await deps.afterStage(stage);
    return undefined;
  } catch (error: unknown) {
    return err("WRITE_FAILED", { message: `stage hook failed at ${stage}: ${String(error)}` });
  }
}

async function runLockedPrimaryStages(
  input: PreparedPagePublication,
  vault: string,
  deps: PagePublishDeps,
): Promise<LockedPublicationOutcome> {
  const state = emptyLockedState();

  // A target path can change between a lock-free preparation/preview and the
  // locked write. Revalidate under the owned lock before any mutation.
  const freshTarget = assertTargetInsideVault(vault, input.page.target);
  if (!freshTarget.ok) {
    return lockedFailure("target", state, freshTarget, ExitCode.VAULT_PATH_INVALID);
  }
  if (freshTarget.data.absolutePath !== input.targetPath) {
    return lockedFailure(
      "target",
      state,
      err("VAULT_PATH_INVALID", { message: "target canonical path changed after preparation" }),
      ExitCode.VAULT_PATH_INVALID,
    );
  }
  if (
    input.source.kind === "file" &&
    freshTarget.data.existingRealPath !== undefined &&
    freshTarget.data.existingRealPath === input.source.realPath
  ) {
    return lockedFailure(
      "target",
      state,
      err("VAULT_PATH_INVALID", { message: "draft now aliases the final target" }),
      ExitCode.VAULT_PATH_INVALID,
    );
  }

  const schemaPath = join(vault, "SCHEMA.md");
  let schemaText: string;
  try {
    schemaText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    return lockedFailure("schema", state, err("WRITE_FAILED", { message: String(error) }));
  }
  const reconciled = reconcileTaxonomyDocument(schemaText, {
    tags: input.page.tags,
    comment: input.taxonomyComment,
  });
  if (!reconciled.ok) {
    return lockedFailure("schema", state, reconciled, errorExitCode(reconciled.error));
  }
  state.taxonomyAdded = reconciled.data.added;
  if (reconciled.data.changed) {
    const schemaWrite = await atomicWriteText(schemaPath, reconciled.data.text);
    if (!schemaWrite.ok) return lockedFailure("schema", state, schemaWrite);
    if (schemaWrite.data.changed) state.changed.add("SCHEMA.md");
  }
  const schemaHook = await observeStage(deps, "schema");
  if (schemaHook) return lockedFailure("schema", state, schemaHook);

  const pageWrite = await safeWritePage(input.targetPath, input.page.content);
  if (!pageWrite.ok) return lockedFailure("page", state, pageWrite);
  state.pageChanged = pageWrite.data.changed;
  if (state.pageChanged) state.changed.add(input.page.target);
  state.published = true;
  const pageHook = await observeStage(deps, "page");
  if (pageHook) return lockedFailure("page", state, pageHook);

  let visible: string;
  let visibleSchema: string;
  try {
    [visible, visibleSchema] = await Promise.all([
      readFile(input.targetPath, "utf8"),
      readFile(schemaPath, "utf8"),
    ]);
  } catch (error: unknown) {
    return lockedFailure("verify", state, err("WRITE_FAILED", { message: String(error) }));
  }
  const visiblePage = prepareTypedPage(visible, input.page.target);
  const visibleTaxonomy = extractTaxonomy(visibleSchema);
  if (
    !visiblePage.ok ||
    visible !== input.page.content ||
    !visibleTaxonomy.ok ||
    input.page.tags.some((tag) => !visibleTaxonomy.data.includes(tag))
  ) {
    return lockedFailure(
      "verify",
      state,
      err("WRITE_FAILED", { message: "published bytes or taxonomy verification failed" }),
    );
  }
  const verifyHook = await observeStage(deps, "verify");
  if (verifyHook) return lockedFailure("verify", state, verifyHook);

  const index = await upsertIndexEntry({
    vault,
    target: input.page.target,
    title: input.page.title,
    type: input.page.type,
  });
  if (!index.ok) return lockedFailure("index", state, index);
  state.indexUpdated = index.data.changed;
  if (state.indexUpdated) state.changed.add("index.md");
  const indexHook = await observeStage(deps, "index");
  if (indexHook) return lockedFailure("index", state, indexHook);

  return { ok: true, data: state };
}

type PagePublishFailureStage =
  | "target"
  | "schema"
  | "page"
  | "verify"
  | "event"
  | "index"
  | "unlock"
  | "log";

function redactDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  try {
    const encoded = JSON.stringify(detail);
    return JSON.parse(redactApprovalTokens(redactSensitiveContent(encoded).text));
  } catch {
    return { message: "unserializable error detail omitted" };
  }
}

function phaseFailure(
  stage: PagePublishFailureStage,
  input: PreparedPagePublication,
  published: boolean,
  cause: ErrResult,
  context: Record<string, unknown> = {},
  exitCode: number = ExitCode.WRITE_FAILED,
): PagePublishRun {
  return {
    exitCode,
    result: err("WRITE_FAILED", {
      ...context,
      stage,
      published,
      target: input.page.target,
      operation_id: input.operationId,
      retry_safe: stage !== "target",
      cause_error: cause.error,
      cause_detail: redactDetail(cause.detail),
    }),
  };
}

function successReceipt(
  input: PreparedPagePublication,
  taxonomyAdded: string[],
  pageChanged: boolean,
  indexUpdated: boolean,
  logAppended: boolean,
  filesChanged: string[],
  dryRun = false,
  receipt: ManagedWriteReceipt | null = null,
  approvalToken?: string,
): PagePublishRun {
  return {
    exitCode: ExitCode.OK,
    result: ok({
      target: input.page.target,
      page_type: input.page.type,
      tags: [...input.page.tags],
      taxonomy_added: [...taxonomyAdded],
      page_changed: pageChanged,
      index_updated: indexUpdated,
      log_appended: logAppended,
      operation_id: input.operationId,
      dry_run: dryRun,
      files_changed: filesChanged,
      base_oid: receipt?.base_oid ?? null,
      write_mode: receipt?.mode ?? null,
      draft_sha256: input.draftSha256,
      target_before: input.priorTargetSha256,
      ...(approvalToken ? { approval_token: approvalToken } : {}),
      ...(receipt ? {
        mutation_vault: receipt.mutation_vault,
        git_vault: receipt.git_vault,
        convergence_source: receipt.convergence_source,
      } : {}),
      ...(receipt?.convergence_vault
        ? { convergence_vault: receipt.convergence_vault }
        : {}),
      ...(receipt?.host_id ? { host_id: receipt.host_id } : {}),
      humanHint: dryRun
        ? `dry run: would publish ${input.page.target} (${input.operationId.slice(0, 12)})`
        : `published ${input.page.target} (${input.operationId.slice(0, 12)})`,
    }),
  };
}

function renderPublicationLog(input: PreparedPagePublication, added: string[]): string {
  return [
    `## [${input.date}] page-publish | ${input.page.target}`,
    "",
    `- Published: [[${input.page.target.replace(/\.md$/, "")}]]`,
    `- Taxonomy: ${added.length > 0 ? `added ${added.join(", ")}` : "no additions"}`,
    ...(input.logNote ? [`- Note: ${input.logNote}`] : []),
  ].join("\n");
}

async function readPageChanged(targetPath: string, content: string): Promise<Result<boolean>> {
  try {
    return ok((await readFile(targetPath, "utf8")) !== content);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(true);
    return err("WRITE_FAILED", { path: targetPath, message: String(error) });
  }
}

/**
 * Compute the exact publication receipt without taking a lock or changing a
 * vault file. This is the shared preview path for draft files and generated
 * in-memory content.
 */
export async function previewPreparedPagePublication(
  input: PreparedPagePublication,
  vault: string,
): Promise<PagePublishRun> {
  const schemaPath = join(vault, "SCHEMA.md");
  let schemaText: string;
  try {
    schemaText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    const result = err("FILE_NOT_FOUND", { path: schemaPath, message: String(error) });
    return { exitCode: ExitCode.FILE_NOT_FOUND, result };
  }
  const reconciled = reconcileTaxonomyDocument(schemaText, {
    tags: input.page.tags,
    comment: input.taxonomyComment,
  });
  if (!reconciled.ok) return { exitCode: errorExitCode(reconciled.error), result: reconciled };

  const pageChanged = await readPageChanged(input.targetPath, input.page.content);
  if (!pageChanged.ok) return { exitCode: errorExitCode(pageChanged.error), result: pageChanged };

  const indexPath = join(vault, "index.md");
  let indexText: string;
  try {
    indexText = await readFile(indexPath, "utf8");
  } catch (error: unknown) {
    const result = err("FILE_NOT_FOUND", { path: indexPath, message: String(error) });
    return { exitCode: ExitCode.FILE_NOT_FOUND, result };
  }
  const index = renderIndexUpsert(indexText, {
    target: input.page.target,
    title: input.page.title,
    type: input.page.type,
  });
  if (!index.ok) return { exitCode: errorExitCode(index.error), result: index };

  const logPath = join(vault, "log.md");
  let logText: string;
  try {
    logText = await readFile(logPath, "utf8");
  } catch (error: unknown) {
    const result = err("FILE_NOT_FOUND", { path: logPath, message: String(error) });
    return { exitCode: ExitCode.FILE_NOT_FOUND, result };
  }
  const logAppended = !logText.includes(`<!-- skillwiki-page-publish:${input.operationId} -->`);

  const filesChanged = [
    ...(reconciled.data.changed ? ["SCHEMA.md"] : []),
    ...(pageChanged.data ? [input.page.target] : []),
    ...(index.data.changed ? ["index.md"] : []),
    ...(logAppended ? ["log.md"] : []),
  ];
  const token = encodeApprovalToken(input.approvalPayload);
  if (!token.ok) return { exitCode: errorExitCode(token.error), result: token };
  return successReceipt(
    input,
    reconciled.data.added,
    pageChanged.data,
    index.data.changed,
    logAppended,
    filesChanged,
    true,
    null,
    token.data,
  );
}

/** Publish a frozen page using an already-approved managed-write receipt. */
export async function publishPreparedPageWithReceipt(
  input: PreparedPagePublication,
  vault: string,
  writeReceipt: ManagedWriteReceipt,
  deps: PagePublishDeps = DEFAULT_DEPS,
): Promise<PagePublishRun> {
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
  // Release B: immutable-record hosts may publish page + event without Git.
  const aggregateMode = resolveRootAggregateMode();

  let lock: ReturnType<typeof acquireOwnedSyncLock>;
  try {
    lock = acquireOwnedSyncLock(vault, {
      summary: `page publish ${input.page.target}`,
      ttlMinutes: 1,
    });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "lock", message: String(error) }),
    };
  }
  if (!lock.ok) return { exitCode: errorExitCode(lock.error), result: lock };

  let primary: LockedPublicationOutcome | undefined;
  let released: Result<{ released: boolean }> | undefined;
  try {
    primary = await runLockedPrimaryStages(input, vault, deps);
  } catch (error: unknown) {
    primary = lockedFailure(
      "schema",
      emptyLockedState(),
      err("WRITE_FAILED", { message: `unexpected primary-stage failure: ${String(error)}` }),
    );
  } finally {
    released = releaseOwnedSyncLock(lock.data);
  }

  const primaryState = primary?.ok ? primary.data : primary?.state;
  if (released === undefined || !released.ok || !released.data.released) {
    return phaseFailure(
      "unlock",
      input,
      primaryState?.published ?? false,
      released && !released.ok ? released : err("WRITE_FAILED", { message: "lock release did not run" }),
      {
        primary_stage: primary && !primary.ok ? primary.stage : "complete",
        primary_error: primary && !primary.ok ? primary.cause.error : undefined,
      },
    );
  }
  const unlockHook = await observeStage(deps, "unlock");
  if (unlockHook) return phaseFailure("unlock", input, primaryState?.published ?? false, unlockHook);

  if (primary === undefined) {
    return phaseFailure(
      "schema",
      input,
      false,
      err("WRITE_FAILED", { message: "locked publication produced no result" }),
    );
  }
  if (!primary.ok) {
    return phaseFailure(
      primary.stage,
      input,
      primary.state.published,
      primary.cause,
      undefined,
      primary.exitCode,
    );
  }

  const state = primary.data;

  // Event-first: immutable record before optional root aggregate dual-write.
  const event = await writeLogEvent(vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: input.operationId,
    occurred_at: `${input.date}T00:00:00.000Z`,
    host_id: writeReceipt.host_id ?? "standalone",
    actor: "skillwiki-cli",
    kind: "page-publish",
    target: input.page.target,
    note: input.logNote ?? `Published ${input.page.title}`,
    metadata: {
      page_type: input.page.type,
      // Stable for replay: do not embed schema-delta taxonomy_added (varies after first write).
      tags: [...input.page.tags].sort(),
      base_oid: writeReceipt.base_oid,
    },
  });
  if (!event.ok) {
    return phaseFailure(
      "event",
      input,
      true,
      event,
      undefined,
      event.error === "EVENT_IDENTITY_COLLISION" ? ExitCode.WRITE_FAILED : errorExitCode(event.error),
    );
  }
  if (event.data.created) state.changed.add(event.data.path);
  const eventHook = await observeStage(deps, "event");
  if (eventHook) return phaseFailure("event", input, true, eventHook);

  let logAppended = false;
  if (aggregateMode === "dual") {
    const log = await runLogAppend({
      vault,
      content: renderPublicationLog(input, state.taxonomyAdded),
      operationId: input.operationId,
      strictLock: true,
      recordLastOp: false,
    });
    if (!log.result.ok) return phaseFailure("log", input, true, log.result);
    if (log.exitCode !== ExitCode.OK) {
      return phaseFailure(
        "log",
        input,
        true,
        err("WRITE_FAILED", { message: "log append returned inconsistent success state" }),
      );
    }
    logAppended = log.result.data.appended;
    if (logAppended) state.changed.add("log.md");
    const logHook = await observeStage(deps, "log");
    if (logHook) return phaseFailure("log", input, true, logHook);
  }

  return successReceipt(
    input,
    state.taxonomyAdded,
    state.pageChanged,
    state.indexUpdated,
    logAppended,
    [...state.changed],
    false,
    writeReceipt,
  );
}

/** Publish a frozen page in the durable order: preflight, schema, page, verify, index, event, log. */
export async function publishPreparedPage(
  input: PreparedPagePublication,
  vault: string,
  deps: PagePublishDeps = DEFAULT_DEPS,
): Promise<PagePublishRun> {
  return runManagedWriteTransaction({
    vault,
    command: `page publish ${input.page.target}`,
    allowImmutableRecord: true,
    preflight: deps.preflight,
    mutate: async (receipt) => publishPreparedPageWithReceipt(input, vault, receipt, deps),
  });
}
/** File-based command entry point used by the grouped `page publish` CLI command. */
export async function runPagePublish(
  input: PagePublishInput,
  deps: PagePublishDeps = DEFAULT_DEPS,
): Promise<PagePublishRun> {
  if (input.approve && !input.write) {
    return {
      exitCode: ExitCode.USAGE,
      result: err("USAGE", { message: "--approve requires --write" }),
    };
  }

  const prepared = await preparePagePublication(input);
  if (!prepared.ok) return { exitCode: errorExitCode(prepared.error), result: prepared };
  if (!input.write) return previewPreparedPagePublication(prepared.data, input.vault);

  if (input.approve) {
    const verified = verifyApprovalToken(input.approve, {
      publisher: "page",
      draft_sha256: prepared.data.draftSha256,
      target: prepared.data.page.target,
      log_note: prepared.data.logNote ?? "",
      prior_target_sha256: prepared.data.priorTargetSha256,
    });
    if (!verified.ok) {
      return {
        exitCode: errorExitCode(verified.error),
        result: err(verified.error, redactDetail(verified.detail)),
      };
    }
  }

  return publishPreparedPage(prepared.data, input.vault, deps);
}
