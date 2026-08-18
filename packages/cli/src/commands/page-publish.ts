import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { err, ok, ExitCode, type ErrResult, type Result } from "@skillwiki/shared";
import { renderProjectIndex } from "./project-index.js";
import { taxonomyCommentForPage } from "../parsers/taxonomy.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { upsertIndexEntry, renderIndexUpsert } from "../utils/index-entry.js";
import {
  type ManagedWritePreflightInput,
  type ManagedWriteReceipt,
  type ManagedWriteMode,
} from "../utils/managed-write-preflight.js";
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
  assertTargetInsideVault,
  prepareTypedPage,
  type PreparedTypedPage,
} from "../utils/typed-page.js";
import {
  DEFAULT_PIPELINE_DEPS,
  errorExitCode,
  executePublicationPipeline,
  publishPreparedWithReceipt as pipelinePublishWithReceipt,
  readPageChanged,
  redactDetail,
  runPipelinePreview,
} from "../publish/pipeline.js";
import {
  resolveRootAggregateMode,
  type PipelineLockedState,
  type PreparedPublicationCore,
  type PublicationPipelineDeps,
  type PublicationStrategy,
  type RootAggregateMode,
} from "../publish/types.js";

export { resolveRootAggregateMode, type RootAggregateMode };

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
  project_index_updated: boolean;
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

export interface PreparedPagePublication extends PreparedPublicationCore {
  page: PreparedTypedPage;
}

export type PublishStage = "schema" | "page" | "verify" | "project-index" | "event" | "index" | "unlock" | "log";

export interface PagePublishDeps {
  afterStage(stage: PublishStage): Promise<void>;
  preflight(
    input: ManagedWritePreflightInput,
  ): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }>;
}

export type PagePublishRun = { exitCode: number; result: Result<PagePublishOutput> };

const DEFAULT_DEPS: PagePublishDeps = {
  afterStage: async () => undefined,
  preflight: (input) => DEFAULT_PIPELINE_DEPS.preflight(input),
};

/** Test-only hook factory; production callers use the immutable default dependency. */
export function defaultPagePublishDeps(overrides: Partial<PagePublishDeps> = {}): PagePublishDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

function projectSlugForTarget(target: string): string | undefined {
  const match = target.match(/^projects\/([^/]+)\/(?:requirements|work|architecture|history|compound)\//);
  return match?.[1];
}

interface ProjectIndexRefresh { changed: boolean; paths: string[] }

export function projectSlugsForPublication(target: string, content: string): string[] {
  const slugs = new Set<string>();
  const pathSlug = projectSlugForTarget(target);
  if (pathSlug) slugs.add(pathSlug);
  const frontmatter = extractFrontmatter(content);
  if (frontmatter.ok && Array.isArray(frontmatter.data.provenance_projects)) {
    for (const entry of frontmatter.data.provenance_projects) {
      const match = String(entry).match(/^\[\[([^\]]+)\]\]$/);
      if (match && /^[a-z0-9][a-z0-9-]*$/i.test(match[1]!)) slugs.add(match[1]!);
    }
  }
  return [...slugs].sort();
}

async function refreshProjectIndexForTarget(
  vault: string,
  projectSlugs: string[],
  today: string,
): Promise<Result<ProjectIndexRefresh>> {
  const paths: string[] = [];
  for (const slug of projectSlugs) {
    const rendered = await renderProjectIndex(vault, slug, { today });
    if (!rendered.ok) return rendered;
    const indexPath = join(vault, rendered.data.index_path);
    try {
      await mkdir(dirname(indexPath), { recursive: true });
    } catch (error: unknown) {
      return err("WRITE_FAILED", { path: indexPath, message: String(error) });
    }
    const written = await atomicWriteText(indexPath, rendered.data.text);
    if (!written.ok) return written;
    try {
      const visible = await readFile(indexPath, "utf8");
      if (visible !== rendered.data.text) {
        return err("WRITE_FAILED", { path: indexPath, message: "project index verification failed" });
      }
    } catch (error: unknown) {
      return err("WRITE_FAILED", { path: indexPath, message: String(error) });
    }
    if (written.data.changed) paths.push(rendered.data.index_path);
  }
  return ok({ changed: paths.length > 0, paths });
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
    target: input.target,
    targetPath: target.data.absolutePath,
    pageType: page.data.type,
    tags: page.data.tags,
    title: page.data.title,
    content: input.content,
    source,
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

function renderPublicationLog(input: PreparedPagePublication, added: string[]): string {
  return [
    `## [${input.date}] page-publish | ${input.page.target}`,
    "",
    `- Published: [[${input.page.target.replace(/\.md$/, "")}]]`,
    `- Taxonomy: ${added.length > 0 ? `added ${added.join(", ")}` : "no additions"}`,
    ...(input.logNote ? [`- Note: ${input.logNote}`] : []),
  ].join("\n");
}

export const PAGE_PUBLISH_STRATEGY: PublicationStrategy<PreparedPagePublication, PagePublishOutput> = {
  publisherKind: "page",
  taxonomyStageName: "schema",
  requireApprovalOnWrite: false,
  usesJournal: false,

  async revalidateTargetUnderLock(prepared, vault) {
    const freshTarget = assertTargetInsideVault(vault, prepared.page.target);
    if (!freshTarget.ok) return freshTarget;
    if (freshTarget.data.absolutePath !== prepared.targetPath) {
      return err("VAULT_PATH_INVALID", { message: "target canonical path changed after preparation" });
    }
    if (
      prepared.source.kind === "file" &&
      freshTarget.data.existingRealPath !== undefined &&
      freshTarget.data.existingRealPath === prepared.source.realPath
    ) {
      return err("VAULT_PATH_INVALID", { message: "draft now aliases the final target" });
    }
    return ok({ absolutePath: freshTarget.data.absolutePath });
  },

  verifyPublishedBytes(prepared, visible) {
    const visiblePage = prepareTypedPage(visible, prepared.page.target);
    return visiblePage.ok && visible === prepared.page.content;
  },

  async updateIndicesLocked(prepared, vault, state, observe) {
    const projectSlugs = projectSlugsForPublication(prepared.page.target, prepared.page.content);
    if (projectSlugs.length > 0) {
      const projectIndex = await refreshProjectIndexForTarget(vault, projectSlugs, prepared.date);
      if (!projectIndex.ok) {
        const detail = typeof projectIndex.detail === "object" && projectIndex.detail !== null
          ? projectIndex.detail
          : { detail: projectIndex.detail };
        return err(projectIndex.error, { ...detail, stage: "project-index" });
      }
      state.projectIndexUpdated = projectIndex.data.changed;
      for (const path of projectIndex.data.paths) state.changed.add(path);
      const projectIndexHook = await observe("project-index");
      if (projectIndexHook) return projectIndexHook;
    }

    const index = await upsertIndexEntry({
      vault,
      target: prepared.page.target,
      title: prepared.page.title,
      type: prepared.page.type,
    });
    if (!index.ok) {
      const detail = typeof index.detail === "object" && index.detail !== null
        ? index.detail
        : { detail: index.detail };
      return err(index.error, { ...detail, stage: "index" });
    }
    state.indexUpdated = index.data.changed;
    if (state.indexUpdated) state.changed.add("index.md");
    const indexHook = await observe("index");
    if (indexHook) return indexHook;

    return undefined;
  },

  async previewIndices(prepared, vault, pageChanged) {
    const indexPath = join(vault, "index.md");
    let indexText: string;
    try {
      indexText = await readFile(indexPath, "utf8");
    } catch (error: unknown) {
      const result = err("FILE_NOT_FOUND", { path: indexPath, message: String(error) });
      return { ok: false, exitCode: ExitCode.FILE_NOT_FOUND, result };
    }
    const index = renderIndexUpsert(indexText, {
      target: prepared.page.target,
      title: prepared.page.title,
      type: prepared.page.type,
    });
    if (!index.ok) return { ok: false, exitCode: errorExitCode(index.error), result: index };

    let projectIndexUpdated = false;
    const projectIndexPaths: string[] = [];
    for (const projectSlug of projectSlugsForPublication(prepared.page.target, prepared.page.content)) {
      const renderedProject = await renderProjectIndex(vault, projectSlug, { today: prepared.date });
      if (!renderedProject.ok) {
        return { ok: false, exitCode: errorExitCode(renderedProject.error), result: renderedProject };
      }
      const projectIndexPath = join(vault, renderedProject.data.index_path);
      const projectIndexChanged = await readPageChanged(projectIndexPath, renderedProject.data.text);
      if (!projectIndexChanged.ok) {
        return { ok: false, exitCode: errorExitCode(projectIndexChanged.error), result: projectIndexChanged };
      }
      if (projectIndexChanged.data || pageChanged) {
        projectIndexUpdated = true;
        projectIndexPaths.push(renderedProject.data.index_path);
      }
    }

    return {
      ok: true,
      data: {
        indexChanged: index.data.changed,
        projectIndexChanged: projectIndexUpdated,
        projectIndexPaths,
      },
    };
  },

  buildLogContent(prepared, added) {
    return renderPublicationLog(prepared, added);
  },

  buildLogEvent(prepared, writeReceipt) {
    return {
      kind: "page-publish",
      note: prepared.logNote ?? `Published ${prepared.page.title}`,
      metadata: {
        page_type: prepared.page.type,
        tags: [...prepared.page.tags].sort(),
        base_oid: writeReceipt.base_oid,
      },
    };
  },

  buildOutput(prepared, details) {
    return {
      target: prepared.page.target,
      page_type: prepared.page.type,
      tags: [...prepared.page.tags],
      taxonomy_added: [...details.taxonomyAdded],
      page_changed: details.pageChanged,
      index_updated: details.indexUpdated ?? false,
      project_index_updated: details.projectIndexChanged,
      log_appended: details.logAppended,
      operation_id: prepared.operationId,
      dry_run: details.dryRun,
      files_changed: details.filesChanged,
      base_oid: details.receipt?.base_oid ?? null,
      write_mode: details.receipt?.mode ?? null,
      draft_sha256: prepared.draftSha256,
      target_before: prepared.priorTargetSha256,
      ...(details.approvalToken ? { approval_token: details.approvalToken } : {}),
      ...(details.receipt ? {
        mutation_vault: details.receipt.mutation_vault,
        git_vault: details.receipt.git_vault,
        convergence_source: details.receipt.convergence_source,
      } : {}),
      ...(details.receipt?.convergence_vault
        ? { convergence_vault: details.receipt.convergence_vault }
        : {}),
      ...(details.receipt?.host_id ? { host_id: details.receipt.host_id } : {}),
      humanHint: details.dryRun
        ? `dry run: would publish ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`
        : `published ${prepared.page.target} (${prepared.operationId.slice(0, 12)})`,
    };
  },
};

/**
 * Compute the exact publication receipt without taking a lock or changing a
 * vault file. This is the shared preview path for draft files and generated
 * in-memory content.
 */
export async function previewPreparedPagePublication(
  input: PreparedPagePublication,
  vault: string,
): Promise<PagePublishRun> {
  return runPipelinePreview(PAGE_PUBLISH_STRATEGY, input, vault);
}

/** Publish a frozen page using an already-approved managed-write receipt. */
export async function publishPreparedPageWithReceipt(
  input: PreparedPagePublication,
  vault: string,
  writeReceipt: ManagedWriteReceipt,
  deps: PagePublishDeps = DEFAULT_DEPS,
): Promise<PagePublishRun> {
  const pipelineDeps: PublicationPipelineDeps = {
    afterStage: (stage) => deps.afterStage(stage as PublishStage),
    preflight: deps.preflight,
  };
  return pipelinePublishWithReceipt(PAGE_PUBLISH_STRATEGY, input, vault, writeReceipt, pipelineDeps);
}

/** Publish a frozen page in the durable order: preflight, schema, page, verify, index, event, log. */
export async function publishPreparedPage(
  input: PreparedPagePublication,
  vault: string,
  deps: PagePublishDeps = DEFAULT_DEPS,
): Promise<PagePublishRun> {
  const pipelineDeps: PublicationPipelineDeps = {
    afterStage: (stage) => deps.afterStage(stage as PublishStage),
    preflight: deps.preflight,
  };
  return executePublicationPipeline(PAGE_PUBLISH_STRATEGY, input, vault, pipelineDeps);
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
