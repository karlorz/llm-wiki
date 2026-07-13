import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import {
  extractTaxonomy,
  reconcileTaxonomyDocument,
  taxonomyCommentForPage,
  type TaxonomyReconcileResult,
} from "../parsers/taxonomy.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { acquireOwnedSyncLock, releaseOwnedSyncLock } from "../utils/sync-lock.js";

const TYPED_TARGET_RE = /^(entities|concepts|comparisons|queries|meta)\/[a-z0-9][a-z0-9./_-]*\.md$/;

export interface TagReconcileInput {
  vault: string;
  page: string;
  from?: string;
  tags?: string[];
  reason?: string;
  write: boolean;
  now?: Date;
}

export interface TagReconcileOutput {
  page: string;
  requested_tags: string[];
  missing_tags: string[];
  added_tags: string[];
  changed: boolean;
  dry_run: boolean;
  files_changed: string[];
  humanHint: string;
}

export type TagReconcileRun = { exitCode: number; result: Result<TagReconcileOutput> };

interface ResolvedTags {
  tags: string[];
}

function errorExitCode(error: string): number {
  switch (error) {
    case "FILE_NOT_FOUND":
      return ExitCode.FILE_NOT_FOUND;
    case "MISSING_CLOSING_DELIMITER":
      return ExitCode.MISSING_CLOSING_DELIMITER;
    case "SCHEME_REJECTED":
      return ExitCode.SCHEME_REJECTED;
    case "VAULT_PATH_INVALID":
      return ExitCode.VAULT_PATH_INVALID;
    case "WRITE_FAILED":
      return ExitCode.WRITE_FAILED;
    case "SYNC_LOCK_HELD":
      return ExitCode.SYNC_LOCK_HELD;
    default:
      return ExitCode.INVALID_FRONTMATTER;
  }
}

function validatePageIdentity(page: string): Result<string> {
  const segments = page.split("/");
  if (
    page.length === 0 ||
    posix.isAbsolute(page) ||
    page.includes("\\") ||
    posix.normalize(page) !== page ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    !TYPED_TARGET_RE.test(page)
  ) {
    return err("VAULT_PATH_INVALID", {
      page,
      message: "page must be a normalized vault-relative typed Markdown path",
    });
  }
  return ok(page);
}

function asTagArray(frontmatter: Record<string, unknown>, path: string): Result<string[]> {
  const tags = frontmatter.tags;
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    return err("INVALID_FRONTMATTER", {
      path,
      message: "frontmatter tags must be an array of strings",
    });
  }
  return ok(tags);
}

async function readTagsFromFile(path: string): Promise<{ exitCode: number; result: Result<string[]> }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path }) };
    }
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path, message: String(error) }) };
  }

  const frontmatter = extractFrontmatter(text);
  if (!frontmatter.ok) return { exitCode: errorExitCode(frontmatter.error), result: frontmatter };
  const tags = asTagArray(frontmatter.data, path);
  if (!tags.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: tags };
  return { exitCode: ExitCode.OK, result: tags };
}

async function resolveRequestedTags(input: TagReconcileInput, page: string): Promise<{ exitCode: number; result: Result<ResolvedTags> }> {
  const explicit = input.tags ?? [];
  if (!Array.isArray(explicit) || !explicit.every((tag) => typeof tag === "string")) {
    return {
      exitCode: ExitCode.INVALID_FRONTMATTER,
      result: err("INVALID_FRONTMATTER", { message: "explicit tags must be an array of strings" }),
    };
  }

  const source = input.from ?? (explicit.length === 0 ? join(input.vault, page) : undefined);
  if (!source) return { exitCode: ExitCode.OK, result: ok({ tags: [...new Set(explicit)].sort() }) };

  const sourced = await readTagsFromFile(source);
  if (!sourced.result.ok) return { exitCode: sourced.exitCode, result: sourced.result };
  return {
    exitCode: ExitCode.OK,
    result: ok({ tags: [...new Set([...explicit, ...sourced.result.data])].sort() }),
  };
}

async function readSchema(schemaPath: string): Promise<{ exitCode: number; result: Result<string> }> {
  try {
    return { exitCode: ExitCode.OK, result: ok(await readFile(schemaPath, "utf8")) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: schemaPath }) };
    }
    return { exitCode: ExitCode.WRITE_FAILED, result: err("WRITE_FAILED", { path: schemaPath, message: String(error) }) };
  }
}

function previewResult(
  page: string,
  tags: string[],
  reconciled: Result<TaxonomyReconcileResult>,
  dryRun: boolean,
  filesChanged: string[],
): TagReconcileRun {
  if (!reconciled.ok) return { exitCode: errorExitCode(reconciled.error), result: reconciled };

  const missingTags = reconciled.data.missing;
  const addedTags = dryRun ? [] : reconciled.data.added;
  const humanHint = dryRun
    ? missingTags.length > 0
      ? `dry run: would add ${missingTags.join(", ")} to taxonomy for ${page}`
      : `dry run: taxonomy already includes requested tags for ${page}`
    : addedTags.length > 0
      ? `added ${addedTags.join(", ")} to taxonomy for ${page}`
      : `taxonomy already includes requested tags for ${page}`;

  return {
    exitCode: ExitCode.OK,
    result: ok({
      page,
      requested_tags: tags,
      missing_tags: missingTags,
      added_tags: addedTags,
      changed: reconciled.data.changed,
      dry_run: dryRun,
      files_changed: filesChanged,
      humanHint,
    }),
  };
}

async function reconcileTagsWhileLocked(
  input: TagReconcileInput,
  page: string,
  tags: string[],
  comment: string,
): Promise<TagReconcileRun> {
  const schemaPath = join(input.vault, "SCHEMA.md");
  const current = await readSchema(schemaPath);
  if (!current.result.ok) return { exitCode: current.exitCode, result: current.result };

  const next = reconcileTaxonomyDocument(current.result.data, { tags, comment });
  if (!next.ok) return { exitCode: errorExitCode(next.error), result: next };

  if (next.data.changed) {
    const written = await atomicWriteText(schemaPath, next.data.text);
    if (!written.ok) return { exitCode: ExitCode.WRITE_FAILED, result: written };
  }

  let verifiedText: string;
  try {
    verifiedText = await readFile(schemaPath, "utf8");
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "verify-taxonomy", page, message: String(error) }),
    };
  }
  const verified = extractTaxonomy(verifiedText);
  if (!verified.ok || tags.some((tag) => !verified.data.includes(tag))) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "verify-taxonomy", page }),
    };
  }

  return previewResult(page, tags, next, false, next.data.changed ? ["SCHEMA.md"] : []);
}

export async function runTagReconcile(input: TagReconcileInput): Promise<TagReconcileRun> {
  const page = validatePageIdentity(input.page);
  if (!page.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: page };

  const resolvedTags = await resolveRequestedTags(input, page.data);
  if (!resolvedTags.result.ok) return { exitCode: resolvedTags.exitCode, result: resolvedTags.result };
  const tags = resolvedTags.result.data.tags;

  const date = (input.now ?? new Date()).toISOString().slice(0, 10);
  const comment = taxonomyCommentForPage(page.data, date, input.reason);
  if (!comment.ok) return { exitCode: ExitCode.SCHEME_REJECTED, result: comment };

  if (!input.write) {
    const schema = await readSchema(join(input.vault, "SCHEMA.md"));
    if (!schema.result.ok) return { exitCode: schema.exitCode, result: schema.result };
    const preview = reconcileTaxonomyDocument(schema.result.data, { tags, comment: comment.data });
    return previewResult(page.data, tags, preview, true, []);
  }

  let lock: ReturnType<typeof acquireOwnedSyncLock>;
  try {
    lock = acquireOwnedSyncLock(input.vault, {
      summary: `tag reconcile ${page.data}`,
      ttlMinutes: 1,
    });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "lock", page: page.data, message: String(error) }),
    };
  }
  if (!lock.ok) return { exitCode: ExitCode.SYNC_LOCK_HELD, result: lock };

  let outcome: TagReconcileRun | undefined;
  let released: Result<{ released: boolean }> | undefined;
  try {
    outcome = await reconcileTagsWhileLocked(input, page.data, tags, comment.data);
  } catch (error: unknown) {
    outcome = {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { stage: "reconcile", page: page.data, message: String(error) }),
    };
  } finally {
    released = releaseOwnedSyncLock(lock.data);
  }

  if (released === undefined || !released.ok) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", {
        stage: "unlock",
        page: page.data,
        primary_error: outcome && !outcome.result.ok ? outcome.result.error : undefined,
        release_error: released && !released.ok ? released.detail : "release did not run",
      }),
    };
  }
  return outcome ?? {
    exitCode: ExitCode.WRITE_FAILED,
    result: err("WRITE_FAILED", {
      stage: "reconcile",
      page: page.data,
      message: "locked reconciliation produced no result",
    }),
  };
}
