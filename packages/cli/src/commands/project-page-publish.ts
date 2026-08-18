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
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { renderProjectIndex } from "./project-index.js";
import { taxonomyCommentForPage } from "../parsers/taxonomy.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import {
  assertArchitectureTargetInsideVault,
  prepareArchitecturePage,
  type PreparedArchitecturePage,
} from "../utils/architecture-page.js";
import {
  type ManagedWritePreflightInput,
  type ManagedWriteReceipt,
  type ManagedWriteMode,
} from "../utils/managed-write-preflight.js";
import {
  buildIdentitySummary,
  type PublicationIdentitySummary,
  type PublicationPhase,
} from "../utils/publication-operation-journal.js";
import {
  buildApprovalPayload,
  normalizeLogNote,
  operationIdFromApproval,
  sha256Hex,
  verifyApprovalToken,
  type ApprovalPayload,
} from "../utils/publication-approval.js";
import { scanSensitiveContent } from "../utils/sensitive-content.js";
import {
  DEFAULT_PIPELINE_DEPS,
  errorExitCode,
  executePublicationPipeline,
  readPriorTargetSha,
  redactDetail,
  runPipelinePreview,
} from "../publish/pipeline.js";
import {
  type PreparedPublicationCore,
  type PublicationPipelineDeps,
  type PublicationStrategy,
} from "../publish/types.js";

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
  held?: boolean;
  hold_reasons?: string[];
  review_event_id?: string;
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
  preflight: (input) => DEFAULT_PIPELINE_DEPS.preflight(input),
};

/** Test-only hook factory. */
export function defaultProjectPagePublishDeps(
  overrides: Partial<ProjectPagePublishDeps> = {},
): ProjectPagePublishDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

export interface PreparedProjectPagePublication extends PreparedPublicationCore {
  page: PreparedArchitecturePage;
  project: string;
  logNote: string;
  identity: PublicationIdentitySummary;
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
  const fm = extractFrontmatter(content);
  let pageType = "concept";
  let title = input.target.split("/").pop()?.replace(/\.md$/, "") ?? input.target;
  let tags: string[] = isNew ? ["adr"] : [];

  if (fm.ok && typeof fm.data === "object" && fm.data !== null) {
    if (typeof fm.data.type === "string") pageType = fm.data.type;
    if (typeof fm.data.title === "string") title = fm.data.title;
    if (Array.isArray(fm.data.tags)) {
      tags = fm.data.tags.filter((t): t is string => typeof t === "string");
    }
  }

  const fallbackPage: PreparedArchitecturePage = {
    target: input.target,
    title,
    type: "concept",
    tags,
    project: input.project,
    content,
    isNew,
  };
  const pageData = page.ok ? page.data : fallbackPage;

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
    page: pageData,
    project: input.project,
    target: input.target,
    targetPath: target.data.absolutePath,
    pageType: pageData.type,
    tags: pageData.tags,
    title: pageData.title,
    content,
    source: { kind: "file", realPath: draftRealPath },
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

export const PROJECT_PAGE_PUBLISH_STRATEGY: PublicationStrategy<
  PreparedProjectPagePublication,
  ProjectPagePublishOutput
> = {
  publisherKind: "project-page",
  taxonomyStageName: "taxonomy",
  requireApprovalOnWrite: true,
  usesJournal: true,

  async revalidateTargetUnderLock(prepared, vault) {
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
  },

  verifyPublishedBytes(prepared, visible) {
    const visiblePage = prepareArchitecturePage(visible, prepared.page.target, prepared.page.project, {
      isNew: false,
    });
    return (
      visiblePage.ok &&
      visible === prepared.content &&
      sha256Hex(visible) === prepared.draftSha256
    );
  },

  async updateIndicesLocked(prepared, vault, state, observe) {
    const rendered = await renderProjectIndex(vault, prepared.page.project, { today: prepared.date });
    if (!rendered.ok) return rendered;

    const knowledgePath = join(vault, rendered.data.index_path);
    try {
      await mkdir(dirname(knowledgePath), { recursive: true });
    } catch (error: unknown) {
      return err("WRITE_FAILED", { message: String(error) });
    }

    const knowledgeWrite = await atomicWriteText(knowledgePath, rendered.data.text);
    if (!knowledgeWrite.ok) return knowledgeWrite;

    state.projectIndexUpdated = knowledgeWrite.data.changed;
    if (state.projectIndexUpdated) state.changed.add(rendered.data.index_path);

    try {
      const visibleIndex = await readFile(knowledgePath, "utf8");
      if (visibleIndex !== rendered.data.text) {
        return err("WRITE_FAILED", { message: "project knowledge.md verification failed" });
      }
    } catch (error: unknown) {
      return err("WRITE_FAILED", { message: String(error) });
    }

    const indexHook = await observe("project-index");
    if (indexHook) return indexHook;

    return undefined;
  },

  async previewIndices(prepared, vault, pageChanged) {
    const projectIndex = await renderProjectIndex(vault, prepared.page.project, { today: prepared.date });
    if (!projectIndex.ok) {
      if (projectIndex.error !== "PROJECT_NOT_FOUND") {
        return { ok: false, exitCode: errorExitCode(projectIndex.error), result: projectIndex };
      }
    }

    let projectIndexChanged = true;
    if (projectIndex.ok) {
      const indexPath = join(vault, projectIndex.data.index_path);
      try {
        const existing = await readFile(indexPath, "utf8");
        projectIndexChanged = existing !== projectIndex.data.text || pageChanged;
      } catch {
        projectIndexChanged = true;
      }
    }

    return {
      ok: true,
      data: {
        projectIndexChanged,
        projectIndexPaths: projectIndexChanged ? [`projects/${prepared.page.project}/knowledge.md`] : [],
      },
    };
  },

  buildLogContent(prepared, added) {
    return renderProjectPublicationLog(prepared, added);
  },

  buildLogEvent(prepared) {
    return {
      kind: "project-page-publish",
      note: prepared.logNote || `Published ${prepared.page.title}`,
      metadata: {
        page_type: prepared.page.type,
        project: prepared.page.project,
        tags: [...prepared.page.tags].sort(),
        draft_sha256: prepared.draftSha256,
      },
    };
  },

  buildOutput(prepared, details) {
    return {
      approval_required: true,
      ...(details.approvalToken ? { approval_token: details.approvalToken } : {}),
      operation_id: prepared.operationId,
      project: prepared.page.project,
      target: prepared.page.target,
      page_type: prepared.page.type,
      tags: [...prepared.page.tags],
      taxonomy_added: [...details.taxonomyAdded],
      page_changed: details.pageChanged,
      project_index_changed: details.projectIndexChanged,
      log_appended: details.logAppended,
      dry_run: details.dryRun,
      files_changed: details.filesChanged,
      draft_sha256: prepared.draftSha256,
      target_before: prepared.priorTargetSha256,
      base_oid: details.receipt?.base_oid ?? null,
      write_mode: details.receipt?.mode ?? null,
      ...(details.held !== undefined ? { held: details.held } : {}),
      ...(details.hold_reasons !== undefined ? { hold_reasons: details.hold_reasons } : {}),
      ...(details.review_event_id !== undefined ? { review_event_id: details.review_event_id } : {}),
      ...(details.receipt
        ? {
            mutation_vault: details.receipt.mutation_vault,
            git_vault: details.receipt.git_vault,
            convergence_source: details.receipt.convergence_source,
          }
        : {}),
      ...(details.receipt?.convergence_vault
        ? { convergence_vault: details.receipt.convergence_vault }
        : {}),
      ...(details.receipt?.host_id ? { host_id: details.receipt.host_id } : {}),
      humanHint: details.held
        ? (details.dryRun
            ? `dry run: would hold ${prepared.page.target} for review (${details.hold_reasons?.join(", ")})`
            : `held ${prepared.page.target} for review (${details.hold_reasons?.join(", ")})`)
        : (details.dryRun
            ? `dry run: would publish ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`
            : `published ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`),
    };
  },
};

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
    return runPipelinePreview(PROJECT_PAGE_PUBLISH_STRATEGY, prepared.data, input.vault);
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

  const pipelineDeps: PublicationPipelineDeps = {
    afterStage: (stage) => deps.afterStage(stage as ProjectPublishStage),
    preflight: deps.preflight,
  };

  return executePublicationPipeline(
    PROJECT_PAGE_PUBLISH_STRATEGY,
    prepared.data,
    input.vault,
    pipelineDeps,
    input.journalHome,
  );
}

// Silence unused import if phase type only used internally via string unions
void (null as unknown as PublicationPhase);
