import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";
import { splitFrontmatter } from "../parsers/frontmatter.js";

/**
 * Defense-in-depth writer for typed-knowledge pages.
 *
 * Mitigates the 2026-05-22 SeaweedFS rclone VFS write-back race in which a
 * plain `writeFile(path, content)` — which is `O_TRUNC` + multiple writes —
 * gave rclone a window between the truncate and the final flush where its
 * upload race ("mod time changed from X to Y") aborted mid-stream and a
 * frontmatter-only stub landed on S3. See
 *   raw/transcripts/2026-05-22-bug-skillwiki-frontmatter-commands-truncate-body.md
 * for the full incident report.
 *
 * Two layers:
 *   1. Atomic temp-write + rename in the same directory. rclone's FUSE layer
 *      sees a single rename — there is no half-written file to race on.
 *   2. Body-shrink guard: if the target exists and the new body collapses to a
 *      tiny fraction of the old body, abort with `BODY_TRUNCATION_GUARD`.
 *      This catches parse-modify-serialize bugs as well as any future race
 *      that re-introduces the same symptom.
 *
 * The guard runs only for substantial pages (default: old body ≥ 200 bytes);
 * small files have noisy ratios and are unlikely to be the high-value content
 * the race truncates anyway.
 */
export interface SafeWriteOptions {
  /**
   * Minimum allowed ratio of new-body bytes to old-body bytes for an in-place
   * rewrite. Below this, the write is rejected. Default 0.5 (lose more than
   * half the body → abort). Set to `null` to disable the guard.
   */
  minBodyRatio?: number | null;
  /**
   * Skip the ratio check when the old body is smaller than this many bytes.
   * Default 200.
   */
  minOldBodyBytes?: number;
}

export interface SafeWriteMetrics {
  /** New file: no prior content. */
  isNew: boolean;
  /** Bytes of old body (after frontmatter), or 0 for new files. */
  oldBodyBytes: number;
  /** Bytes of new body (after frontmatter). */
  newBodyBytes: number;
  /** new/old ratio when measurable; null when oldBody is empty. */
  bodyRatio: number | null;
  /** True when the guard would have rejected but was suppressed (small file). */
  guardSkippedSmall: boolean;
}

const DEFAULT_MIN_BODY_RATIO = 0.5;
const DEFAULT_MIN_OLD_BODY_BYTES = 200;

function bodyBytes(text: string): number {
  const split = splitFrontmatter(text);
  if (!split.ok) return Buffer.byteLength(text, "utf8");
  return Buffer.byteLength(split.data.body, "utf8");
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Write content to a typed-knowledge page atomically, with body-shrink guard.
 *
 * Returns:
 *   ok({ ...metrics }) — wrote successfully (or the new content was identical to
 *     the existing file, which is a no-op)
 *   err("BODY_TRUNCATION_GUARD", detail) — guard rejected the write
 *   err("WRITE_FAILED", detail) — filesystem error
 */
export async function safeWritePage(
  absPath: string,
  newContent: string,
  opts: SafeWriteOptions = {}
): Promise<Result<SafeWriteMetrics>> {
  const minRatio = opts.minBodyRatio === undefined ? DEFAULT_MIN_BODY_RATIO : opts.minBodyRatio;
  const minOldBytes = opts.minOldBodyBytes ?? DEFAULT_MIN_OLD_BODY_BYTES;

  let oldContent: string | null;
  try {
    oldContent = await readIfExists(absPath);
  } catch (e: unknown) {
    return err("WRITE_FAILED", { path: absPath, phase: "read-existing", message: String(e) });
  }

  const isNew = oldContent === null;
  const oldBodyBytes = isNew ? 0 : bodyBytes(oldContent!);
  const newBodyBytes = bodyBytes(newContent);
  const bodyRatio = oldBodyBytes > 0 ? newBodyBytes / oldBodyBytes : null;

  let guardSkippedSmall = false;
  if (
    !isNew &&
    minRatio !== null &&
    bodyRatio !== null &&
    bodyRatio < minRatio
  ) {
    if (oldBodyBytes < minOldBytes) {
      guardSkippedSmall = true;
    } else {
      return err("BODY_TRUNCATION_GUARD", {
        path: absPath,
        oldBodyBytes,
        newBodyBytes,
        bodyRatio,
        minBodyRatio: minRatio,
        hint: "Refusing to write — new body lost too much content. Likely a parse-modify-serialize bug or a write race. Verify the page source before retrying."
      });
    }
  }

  // Fast path: identical content. Skip the rename to avoid spurious mtime bumps
  // (which themselves can trigger rclone uploads).
  if (!isNew && oldContent === newContent) {
    return ok({ isNew: false, oldBodyBytes, newBodyBytes, bodyRatio, guardSkippedSmall });
  }

  const dir = dirname(absPath);
  const tmpName = `.${basename(absPath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = join(dir, tmpName);

  try {
    // Write + fsync the temp file so the bytes hit the filesystem before the
    // rename publishes the new inode. fsync is best-effort on FUSE mounts but
    // is the only Node-level hook we have.
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(newContent, "utf8");
      try { await handle.sync(); } catch { /* fsync optional on FUSE */ }
    } finally {
      await handle.close();
    }
    await rename(tmpPath, absPath);
    return ok({ isNew, oldBodyBytes, newBodyBytes, bodyRatio, guardSkippedSmall });
  } catch (e: unknown) {
    // Clean up the temp file if rename failed; ignore unlink errors.
    try { await unlink(tmpPath); } catch { /* ignore */ }
    return err("WRITE_FAILED", { path: absPath, phase: "atomic-write", message: String(e) });
  }
}

/**
 * Thin wrapper for callers that want the legacy "throw on error" ergonomics of
 * fs.writeFile. Returns void on success; throws an Error tagged with the
 * Result detail on failure. Used by command sites that previously called
 * `await writeFile(absPath, newText, "utf8")` directly.
 */
export async function safeWritePageOrThrow(
  absPath: string,
  newContent: string,
  opts: SafeWriteOptions = {}
): Promise<SafeWriteMetrics> {
  const r = await safeWritePage(absPath, newContent, opts);
  if (r.ok) return r.data;
  const e = new Error(`safeWritePage failed: ${r.error}`) as Error & { code: string; detail: unknown };
  e.code = r.error;
  e.detail = r.detail;
  throw e;
}

// Re-export plain writeFile for callers that genuinely need a non-guarded
// write (e.g. ingesting brand-new raw files, where the guard has no baseline
// to compare against — though those callers should normally just pass through
// safeWritePage, which short-circuits for new files).
export { writeFile as plainWriteFile };
