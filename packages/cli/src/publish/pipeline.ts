import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { err, ok, ExitCode, type ErrResult, type Result } from "@skillwiki/shared";
import { runLogAppend } from "../commands/log-append.js";
import { extractTaxonomy, reconcileTaxonomyDocument } from "../parsers/taxonomy.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { git } from "../utils/git.js";
import {
  runManagedWritePreflight,
  runManagedWriteTransaction,
  type ManagedWritePreflightInput,
  type ManagedWriteReceipt,
} from "../utils/managed-write-preflight.js";
import { writeLogEvent } from "../utils/log-events.js";
import {
  advancePublicationJournal,
  completePublicationJournal,
  createPublicationJournal,
  isValidPhase,
  readPublicationJournal,
  type PublicationPhase,
} from "../utils/publication-operation-journal.js";
import {
  encodeApprovalToken,
  redactApprovalTokens,
  sha256Hex,
  verifyApprovalToken,
} from "../utils/publication-approval.js";
import { redactSensitiveContent } from "../utils/sensitive-content.js";
import { safeWritePage } from "../utils/safe-write.js";
import { acquireOwnedSyncLock, releaseOwnedSyncLock } from "../utils/sync-lock.js";
import {
  emitPublicationHoldReviewEvent,
  evaluatePublicationHoldGates,
} from "./hold-gates.js";
import {
  resolveRootAggregateMode,
  type PipelineLockedState,
  type PipelineStageName,
  type PreparedPublicationCore,
  type PublicationPipelineDeps,
  type PublicationStrategy,
} from "./types.js";

export function errorExitCode(error: string): number {
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

export function redactDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  try {
    const encoded = JSON.stringify(detail);
    const redacted = redactApprovalTokens(redactSensitiveContent(encoded).text);
    return JSON.parse(redacted);
  } catch {
    return { message: "unserializable error detail omitted" };
  }
}

export const DEFAULT_PIPELINE_DEPS: PublicationPipelineDeps = {
  afterStage: async () => undefined,
  preflight: (input: ManagedWritePreflightInput) => runManagedWritePreflight(input),
};

export async function observeStage(
  deps: PublicationPipelineDeps,
  stage: string,
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

export function emptyLockedState(): PipelineLockedState {
  return {
    taxonomyAdded: [],
    pageChanged: false,
    indexUpdated: false,
    projectIndexUpdated: false,
    published: false,
    verified: false,
    changed: new Set<string>(),
  };
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

export async function readPageChanged(targetPath: string, content: string): Promise<Result<boolean>> {
  try {
    return ok((await readFile(targetPath, "utf8")) !== content);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok(true);
    return err("WRITE_FAILED", { path: targetPath, message: String(error) });
  }
}

export async function readPriorTargetSha(targetPath: string): Promise<Result<string>> {
  try {
    const text = await readFile(targetPath, "utf8");
    return ok(sha256Hex(text));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok("absent");
    return err("WRITE_FAILED", { path: targetPath, message: String(error) });
  }
}

export function phaseFailure<TPrepared extends PreparedPublicationCore, TOutput>(
  stage: string,
  prepared: TPrepared,
  published: boolean,
  verified: boolean,
  cause: ErrResult,
  publisherKind: "page" | "project-page",
  context: Record<string, unknown> = {},
  exitCode: number = ExitCode.WRITE_FAILED,
): { exitCode: number; result: Result<TOutput> } {
  const errorKey = publisherKind === "page"
    ? "WRITE_FAILED"
    : cause.error === "EVENT_IDENTITY_COLLISION"
    ? "WRITE_FAILED"
    : cause.error;

  const resolvedExitCode = publisherKind === "page"
    ? exitCode
    : exitCode === ExitCode.WRITE_FAILED
    ? errorExitCode(cause.error) || ExitCode.WRITE_FAILED
    : exitCode;

  const detail: Record<string, unknown> = {
    ...context,
    stage,
    published,
    ...(publisherKind === "project-page" ? { verified } : {}),
    target: prepared.target,
    operation_id: prepared.operationId,
    retry_safe: stage !== "target" && (publisherKind === "page" || cause.error !== "TARGET_DRIFT"),
    cause_error: cause.error,
    cause_detail: redactDetail(cause.detail),
  };

  return {
    exitCode: resolvedExitCode,
    result: err(errorKey, detail),
  };
}

export function successReceipt<TPrepared extends PreparedPublicationCore, TOutput>(
  strategy: PublicationStrategy<TPrepared, TOutput>,
  prepared: TPrepared,
  details: {
    taxonomyAdded: string[];
    pageChanged: boolean;
    indexUpdated?: boolean;
    projectIndexChanged: boolean;
    logAppended: boolean;
    filesChanged: string[];
    dryRun: boolean;
    approvalToken?: string;
    receipt?: ManagedWriteReceipt | null;
    held?: boolean;
    hold_reasons?: string[];
    review_event_id?: string;
  },
): { exitCode: number; result: Result<TOutput> } {
  return {
    exitCode: ExitCode.OK,
    result: ok(strategy.buildOutput(prepared, details)),
  };
}

export async function runPipelinePreview<TPrepared extends PreparedPublicationCore, TOutput>(
  strategy: PublicationStrategy<TPrepared, TOutput>,
  prepared: TPrepared,
  vault: string,
): Promise<{ exitCode: number; result: Result<TOutput> }> {
  const schemaPath = join(vault, "SCHEMA.md");
  let schemaText: string;
  try {
    schemaText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    const result = err("FILE_NOT_FOUND", { path: schemaPath, message: String(error) });
    return { exitCode: ExitCode.FILE_NOT_FOUND, result };
  }

  const reconciled = reconcileTaxonomyDocument(schemaText, {
    tags: prepared.tags,
    comment: prepared.taxonomyComment,
  });
  if (!reconciled.ok) return { exitCode: errorExitCode(reconciled.error), result: reconciled };

  let pageChanged: boolean;
  if (strategy.publisherKind === "page") {
    const pc = await readPageChanged(prepared.targetPath, prepared.content);
    if (!pc.ok) return { exitCode: errorExitCode(pc.error), result: pc };
    pageChanged = pc.data;
  } else {
    const prior = await readPriorTargetSha(prepared.targetPath);
    if (!prior.ok) return { exitCode: errorExitCode(prior.error), result: prior };
    pageChanged = prior.data === "absent" || prior.data !== prepared.draftSha256;
  }

  const indices = await strategy.previewIndices(prepared, vault, pageChanged);
  if (!indices.ok) {
    return { exitCode: indices.exitCode, result: indices.result };
  }

  const logPath = join(vault, "log.md");
  let logAppended: boolean;
  try {
    const logText = await readFile(logPath, "utf8");
    const marker = strategy.publisherKind === "page"
      ? `<!-- skillwiki-page-publish:${prepared.operationId} -->`
      : `<!-- skillwiki-project-page-publish:${prepared.operationId} -->`;
    logAppended = !logText.includes(marker);
  } catch (error: unknown) {
    const result = err("FILE_NOT_FOUND", { path: logPath, ...(strategy.publisherKind === "page" ? { message: String(error) } : {}) });
    return { exitCode: ExitCode.FILE_NOT_FOUND, result };
  }

  const token = encodeApprovalToken(prepared.approvalPayload);
  if (!token.ok) return { exitCode: errorExitCode(token.error), result: token };

  const holdEval = await evaluatePublicationHoldGates({
    prepared,
    vault,
    publisherKind: strategy.publisherKind,
  });

  const filesChanged = strategy.publisherKind === "page"
    ? [
        ...(reconciled.data.changed ? ["SCHEMA.md"] : []),
        ...(pageChanged ? [prepared.target] : []),
        ...indices.data.projectIndexPaths,
        ...(indices.data.indexChanged ? ["index.md"] : []),
        ...(logAppended ? ["log.md"] : []),
      ]
    : [
        ...(reconciled.data.changed ? ["SCHEMA.md"] : []),
        ...(pageChanged ? [prepared.target] : []),
        ...(indices.data.projectIndexChanged && prepared.project ? [`projects/${prepared.project}/knowledge.md`] : []),
        ...(logAppended ? ["log.md"] : []),
      ];

  return successReceipt(strategy, prepared, {
    taxonomyAdded: reconciled.data.added,
    pageChanged,
    indexUpdated: indices.data.indexChanged,
    projectIndexChanged: indices.data.projectIndexChanged,
    logAppended,
    filesChanged,
    dryRun: true,
    approvalToken: token.data,
    held: holdEval.held,
    hold_reasons: holdEval.hold_reasons,
  });
}

export type LockedPrimaryOutcome =
  | { ok: true; data: PipelineLockedState }
  | {
      ok: false;
      exitCode: number;
      stage: string;
      state: PipelineLockedState;
      cause: ErrResult;
    };

export async function runPipelineLockedPrimaryStages<TPrepared extends PreparedPublicationCore, TOutput>(
  strategy: PublicationStrategy<TPrepared, TOutput>,
  prepared: TPrepared,
  vault: string,
  deps: PublicationPipelineDeps,
  journalHome?: string,
): Promise<LockedPrimaryOutcome> {
  const state = emptyLockedState();
  const taxonomyStage = strategy.taxonomyStageName;

  const revalidated = await strategy.revalidateTargetUnderLock(prepared, vault);
  if (!revalidated.ok) {
    return {
      ok: false,
      exitCode: errorExitCode(revalidated.error),
      stage: "target",
      state,
      cause: revalidated,
    };
  }

  let currentPhase: PublicationPhase = "locked";
  if (strategy.usesJournal && prepared.identity) {
    const existingJournal = readPublicationJournal(vault, prepared.operationId, journalHome);
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
        home: journalHome,
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
  }

  // Schema/Taxonomy Stage
  const schemaPath = join(vault, "SCHEMA.md");
  let schemaText: string;
  try {
    schemaText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    return {
      ok: false,
      exitCode: ExitCode.WRITE_FAILED,
      stage: taxonomyStage,
      state,
      cause: err("WRITE_FAILED", { message: String(error) }),
    };
  }
  const reconciled = reconcileTaxonomyDocument(schemaText, {
    tags: prepared.tags,
    comment: prepared.taxonomyComment,
  });
  if (!reconciled.ok) {
    return {
      ok: false,
      exitCode: errorExitCode(reconciled.error),
      stage: taxonomyStage,
      state,
      cause: reconciled,
    };
  }
  state.taxonomyAdded = reconciled.data.added;
  if (reconciled.data.changed) {
    const schemaWrite = await atomicWriteText(schemaPath, reconciled.data.text);
    if (!schemaWrite.ok) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: taxonomyStage, state, cause: schemaWrite };
    }
    if (schemaWrite.data.changed) state.changed.add("SCHEMA.md");
  }

  if (strategy.usesJournal && prepared.identity && !phaseAtLeast(currentPhase, "taxonomy")) {
    advancePublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      nextPhase: "taxonomy",
      filesChanged: [...state.changed],
      home: journalHome,
    });
    currentPhase = "taxonomy";
  }

  const schemaHook = await observeStage(deps, taxonomyStage);
  if (schemaHook) {
    return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: taxonomyStage, state, cause: schemaHook };
  }

  // Page write stage
  if (!strategy.usesJournal || !phaseAtLeast(currentPhase, "page")) {
    if (strategy.publisherKind === "project-page") {
      try {
        const { mkdir } = await import("node:fs/promises");
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
    }

    const pageWrite = await safeWritePage(prepared.targetPath, prepared.content);
    if (!pageWrite.ok) {
      return {
        ok: false,
        exitCode: errorExitCode(pageWrite.error),
        stage: "page",
        state,
        cause: pageWrite,
      };
    }
    state.pageChanged = pageWrite.data.changed;
    if (state.pageChanged) state.changed.add(prepared.target);
    state.published = true;

    if (strategy.usesJournal && prepared.identity) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "page",
        published: true,
        filesChanged: [...state.changed],
        home: journalHome,
      });
      currentPhase = "page";
    }

    const pageHook = await observeStage(deps, "page");
    if (pageHook) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "page", state, cause: pageHook };
    }
  } else {
    state.published = true;
  }

  // Verify stage
  if (!strategy.usesJournal || !phaseAtLeast(currentPhase, "verified")) {
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

    const visibleTaxonomy = extractTaxonomy(visibleSchema);
    const taxonomyValid = visibleTaxonomy.ok && !prepared.tags.some((tag) => !visibleTaxonomy.data.includes(tag));
    const verified = taxonomyValid && strategy.verifyPublishedBytes(
      prepared,
      visible,
      visibleTaxonomy.ok ? visibleTaxonomy.data : [],
    );

    if (!verified) {
      return {
        ok: false,
        exitCode: ExitCode.WRITE_FAILED,
        stage: "verify",
        state,
        cause: err("WRITE_FAILED", { message: "published bytes or taxonomy verification failed" }),
      };
    }

    state.verified = true;
    if (strategy.usesJournal && prepared.identity) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "verified",
        published: true,
        verified: true,
        filesChanged: [...state.changed],
        home: journalHome,
      });
      currentPhase = "verified";
    }

    const verifyHook = await observeStage(deps, "verify");
    if (verifyHook) {
      return { ok: false, exitCode: ExitCode.WRITE_FAILED, stage: "verify", state, cause: verifyHook };
    }
  } else {
    state.verified = true;
  }

  // Indices update stage
  if (!strategy.usesJournal || !phaseAtLeast(currentPhase, "project-index")) {
    const indicesError = await strategy.updateIndicesLocked(
      prepared,
      vault,
      state,
      (stage: string) => observeStage(deps, stage),
    );
    if (indicesError) {
      return {
        ok: false,
        exitCode: errorExitCode(indicesError.error),
        stage: strategy.publisherKind === "page"
          ? (indicesError.detail && typeof indicesError.detail === "object" && "stage" in (indicesError.detail as Record<string, unknown>)
              ? String((indicesError.detail as Record<string, unknown>).stage)
              : "project-index")
          : "project-index",
        state,
        cause: indicesError,
      };
    }

    if (strategy.usesJournal && prepared.identity) {
      advancePublicationJournal({
        vaultPath: vault,
        operationId: prepared.operationId,
        identity: prepared.identity,
        nextPhase: "project-index",
        published: true,
        verified: true,
        filesChanged: [...state.changed],
        home: journalHome,
      });
      currentPhase = "project-index";
    }
  }

  return { ok: true, data: state };
}

export async function publishPreparedWithReceipt<TPrepared extends PreparedPublicationCore, TOutput>(
  strategy: PublicationStrategy<TPrepared, TOutput>,
  prepared: TPrepared,
  vault: string,
  writeReceipt: ManagedWriteReceipt,
  deps: PublicationPipelineDeps,
  journalHome?: string,
): Promise<{ exitCode: number; result: Result<TOutput> }> {
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

  // Preflight hold-gate evaluation: if any gate trips, page is HELD for review.
  const holdEval = await evaluatePublicationHoldGates({
    prepared,
    vault,
    publisherKind: strategy.publisherKind,
  });

  if (holdEval.held) {
    const reviewEvent = await emitPublicationHoldReviewEvent({
      vault,
      prepared,
      holdReasons: holdEval.hold_reasons,
      hostId: writeReceipt.host_id,
    });
    if (!reviewEvent.ok) {
      return {
        exitCode: errorExitCode(reviewEvent.error),
        result: reviewEvent,
      };
    }

    return successReceipt(strategy, prepared, {
      taxonomyAdded: [],
      pageChanged: false,
      indexUpdated: false,
      projectIndexChanged: false,
      logAppended: false,
      filesChanged: [reviewEvent.data.event_path],
      dryRun: false,
      receipt: writeReceipt,
      held: true,
      hold_reasons: holdEval.hold_reasons,
      review_event_id: reviewEvent.data.operation_id,
    });
  }

  const aggregateMode = resolveRootAggregateMode();

  let lock: ReturnType<typeof acquireOwnedSyncLock>;
  try {
    lock = acquireOwnedSyncLock(vault, {
      summary: `${strategy.publisherKind === "page" ? "page" : "project-page"} publish ${prepared.target}`,
      ttlMinutes: 1,
    });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "lock", message: String(error) }),
    };
  }
  if (!lock.ok) return { exitCode: errorExitCode(lock.error), result: lock };

  let primary: LockedPrimaryOutcome | undefined;
  let released: Result<{ released: boolean }> | undefined;
  try {
    primary = await runPipelineLockedPrimaryStages(strategy, prepared, vault, deps, journalHome);
  } catch (error: unknown) {
    primary = {
      ok: false,
      exitCode: ExitCode.WRITE_FAILED,
      stage: strategy.taxonomyStageName,
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
      strategy.publisherKind,
      strategy.publisherKind === "page"
        ? {
            primary_stage: primary && !primary.ok ? primary.stage : "complete",
            primary_error: primary && !primary.ok ? primary.cause.error : undefined,
          }
        : {},
    );
  }

  if (strategy.usesJournal && prepared.identity) {
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
      strategy.publisherKind,
    );
  }

  if (primary === undefined) {
    return phaseFailure(
      strategy.taxonomyStageName,
      prepared,
      false,
      false,
      err("WRITE_FAILED", { message: "locked publication produced no result" }),
      strategy.publisherKind,
    );
  }

  if (!primary.ok) {
    return phaseFailure(
      primary.stage,
      prepared,
      primary.state.published,
      primary.state.verified,
      primary.cause,
      strategy.publisherKind,
      undefined,
      primary.exitCode,
    );
  }

  const state = primary.data;

  // Event stage
  const logEventDef = strategy.buildLogEvent(prepared, writeReceipt);
  const event = await writeLogEvent(vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: prepared.operationId,
    occurred_at: `${prepared.date}T00:00:00.000Z`,
    host_id: writeReceipt.host_id ?? "standalone",
    actor: "skillwiki-cli",
    kind: logEventDef.kind,
    target: prepared.target,
    note: logEventDef.note,
    metadata: logEventDef.metadata,
  });

  if (!event.ok) {
    return phaseFailure(
      "event",
      prepared,
      true,
      true,
      event,
      strategy.publisherKind,
      undefined,
      event.error === "EVENT_IDENTITY_COLLISION" ? ExitCode.WRITE_FAILED : errorExitCode(event.error),
    );
  }
  if (event.data.created) state.changed.add(event.data.path);

  if (strategy.usesJournal && prepared.identity) {
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
  if (eventHook) {
    return phaseFailure("event", prepared, true, true, eventHook, strategy.publisherKind);
  }

  // Log append stage
  let logAppended = false;
  if (aggregateMode === "dual") {
    const log = await runLogAppend({
      vault,
      content: strategy.buildLogContent(prepared, state.taxonomyAdded),
      operationId: prepared.operationId,
      strictLock: true,
      recordLastOp: false,
      ...(strategy.publisherKind === "project-page" ? { eventKind: "project-page-publish" } : {}),
    });
    if (!log.result.ok) {
      return phaseFailure("log", prepared, true, true, log.result, strategy.publisherKind);
    }
    if (log.exitCode !== ExitCode.OK) {
      return phaseFailure(
        "log",
        prepared,
        true,
        true,
        err("WRITE_FAILED", { message: "log append returned inconsistent success state" }),
        strategy.publisherKind,
      );
    }
    logAppended = log.result.data.appended;
    if (logAppended) state.changed.add("log.md");

    if (strategy.usesJournal && prepared.identity) {
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
    if (logHook) {
      return phaseFailure("log", prepared, true, true, logHook, strategy.publisherKind);
    }
  }

  // Journal cleanup stage
  if (strategy.usesJournal && prepared.identity) {
    const completed = completePublicationJournal({
      vaultPath: vault,
      operationId: prepared.operationId,
      identity: prepared.identity,
      filesChanged: [...state.changed],
      home: journalHome,
    });
    if (!completed.ok) {
      if (completed.error !== "RECOVERY_EVIDENCE_MISSING") {
        return phaseFailure("journal-cleanup", prepared, true, true, completed, strategy.publisherKind);
      }
    }
    const cleanupHook = await observeStage(deps, "journal-cleanup");
    if (cleanupHook) {
      return phaseFailure("journal-cleanup", prepared, true, true, cleanupHook, strategy.publisherKind);
    }
  }

  return successReceipt(strategy, prepared, {
    taxonomyAdded: state.taxonomyAdded,
    pageChanged: state.pageChanged,
    indexUpdated: state.indexUpdated,
    projectIndexChanged: state.projectIndexUpdated,
    logAppended,
    filesChanged: [...state.changed],
    dryRun: false,
    receipt: writeReceipt,
  });
}

export async function executePublicationPipeline<TPrepared extends PreparedPublicationCore, TOutput>(
  strategy: PublicationStrategy<TPrepared, TOutput>,
  prepared: TPrepared,
  vault: string,
  deps: PublicationPipelineDeps,
  journalHome?: string,
): Promise<{ exitCode: number; result: Result<TOutput> }> {
  return runManagedWriteTransaction({
    vault,
    command: `${strategy.publisherKind === "page" ? "page" : "project-page"} publish ${prepared.target}`,
    allowImmutableRecord: true,
    preflight: deps.preflight,
    mutate: async (receipt) => publishPreparedWithReceipt(strategy, prepared, vault, receipt, deps, journalHome),
  });
}
