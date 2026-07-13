import { readFile, open, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ok, err, ExitCode, RawSourceSchema, type Result } from "@skillwiki/shared";
import { runFetchGuardSync } from "./fetch-guard.js";
import { controlledFetch } from "../utils/fetch.js";
import { appendLastOp } from "../utils/last-op.js";
import { assessSourceIdentity } from "../utils/source-identity.js";
import { scanSensitiveContent } from "../utils/sensitive-content.js";
import {
  preparePagePublicationFromContent,
  previewPreparedPagePublication,
  publishPreparedPage,
  type PagePublishOutput,
} from "./page-publish.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "../utils/atomic-write.js";

const ALLOWED_TYPES = new Set(["entity", "concept", "comparison", "query"]);
const TYPE_DIR: Record<string, string> = {
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  query: "queries",
};
const ALLOWED_PROVENANCE = new Set(["research", "project"]);

export interface IngestInput {
  source: string;
  vault: string;
  type: string;
  title: string;
  tags?: string[];
  provenance?: string;
  dryRun?: boolean;
}

export interface IngestOutput {
  raw_path: string;
  typed_path: string;
  sha256: string;
  dry_run: boolean;
  humanHint: string;
  publication: PagePublishOutput;
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "untitled";
}

function isUrl(source: string): boolean {
  try {
    const u = new URL(source);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildRawContent(
  sourceUrl: string | null,
  ingested: string,
  sha256: string,
  body: string
): string {
  const lines = [
    "---",
    sourceUrl !== null ? `source_url: "${sourceUrl}"` : "source_url:",
    `created: ${ingested}`,
    `ingested: ${ingested}`,
    `sha256: ${sha256}`,
    `ingested_by: wiki-ingest`,
    "---",
    "",
    body,
  ];
  return lines.join("\n");
}

function buildTypedContent(
  title: string,
  ingested: string,
  type: string,
  tags: string[],
  rawRelPath: string,
  provenance: string | undefined
): string {
  const aliases: string[] = [];
  const sourcesYaml = `  - ${rawRelPath}`;
  const tagsYaml = tags.length > 0 ? tags.map(t => `  - ${t}`).join("\n") : "  []";

  const fmLines = ["---"];
  fmLines.push(`title: "${title}"`);
  if (aliases.length > 0) {
    fmLines.push("aliases:");
    for (const a of aliases) fmLines.push(`  - ${a}`);
  } else {
    fmLines.push("aliases: []");
  }
  fmLines.push(`created: ${ingested}`);
  fmLines.push(`updated: ${ingested}`);
  fmLines.push(`type: ${type}`);
  fmLines.push("tags:");
  fmLines.push(tagsYaml);
  fmLines.push("sources:");
  fmLines.push(sourcesYaml);
  fmLines.push("confidence: medium");
  if (provenance) {
    fmLines.push(`provenance: ${provenance}`);
  }
  fmLines.push("---");
  fmLines.push("");

  const body = [
    `# ${title}`,
    "",
    "## Overview",
    "",
    "## See also",
    "",
    "## Sources",
    "",
    `^[${rawRelPath}]`,
    "",
  ].join("\n");

  return fmLines.join("\n") + body;
}

interface ResolvedRawCapture {
  content: string;
  ingested: string;
  shouldWrite: boolean;
}

async function resolveRawCapture(input: {
  path: string;
  sourceUrl: string | null;
  sourceContent: string;
  sha256: string;
  today: string;
}): Promise<Result<ResolvedRawCapture>> {
  try {
    const existing = await readFile(input.path, "utf8");
    const frontmatter = extractFrontmatter(existing);
    if (!frontmatter.ok) {
      return err("INGEST_VALIDATION_FAILED", {
        path: input.path,
        message: "existing immutable raw source has invalid frontmatter",
        source_error: frontmatter.error,
      });
    }
    const parsed = RawSourceSchema.safeParse(frontmatter.data);
    if (
      !parsed.success ||
      parsed.data.sha256 !== input.sha256 ||
      (parsed.data.source_url ?? null) !== input.sourceUrl ||
      existing !== buildRawContent(
        input.sourceUrl,
        String(parsed.data.ingested),
        input.sha256,
        input.sourceContent,
      )
    ) {
      return err("INGEST_VALIDATION_FAILED", {
        path: input.path,
        message: "existing immutable raw source differs from the fetched source",
      });
    }
    return ok({
      content: existing,
      ingested: String(parsed.data.ingested),
      shouldWrite: false,
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return err("WRITE_FAILED", { path: input.path, message: String(error) });
    }
  }

  return ok({
    content: buildRawContent(input.sourceUrl, input.today, input.sha256, input.sourceContent),
    ingested: input.today,
    shouldWrite: true,
  });
}

async function writeResolvedRaw(input: {
  path: string;
  sourceUrl: string | null;
  sourceContent: string;
  sha256: string;
  today: string;
  capture: ResolvedRawCapture;
}): Promise<Result<{ changed: boolean; capture: ResolvedRawCapture }>> {
  if (!input.capture.shouldWrite) return ok({ changed: false, capture: input.capture });
  const lock = await acquireRawCaptureLock(input.path);
  if (!lock.ok) return lock;
  try {
    // The initial plan can be stale by the time this writer gets the raw lock.
    // Re-resolve inside the lock before any atomic write or publication prep.
    const resolved = await resolveRawCapture(input);
    if (!resolved.ok) return resolved;
    if (!resolved.data.shouldWrite) return ok({ changed: false, capture: resolved.data });

    const written = await atomicWriteText(input.path, resolved.data.content);
    return written.ok
      ? ok({ changed: written.data.changed, capture: resolved.data })
      : written;
  } finally {
    try {
      await unlink(lock.data);
    } catch {
      // A failed lock cleanup prevents a second writer from proceeding, which
      // is safer than allowing an immutable capture to be replaced.
    }
  }
}

/**
 * Serialize raw-capture creation without taking the publisher's global lock:
 * ingest must be able to preserve the raw source even when typed publication
 * is held. O_EXCL works on the same FUSE-capable filesystem surface as the
 * existing sync locks, while the actual page write stays `atomicWriteText`.
 */
async function acquireRawCaptureLock(
  path: string,
): Promise<Result<string>> {
  const lockPath = `${path}.ingest.lock`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return ok(lockPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return err("WRITE_FAILED", { path: lockPath, phase: "raw-lock", message: String(error) });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  return err("WRITE_FAILED", { path: lockPath, phase: "raw-lock", message: "raw capture lock held" });
}

export async function runIngest(
  input: IngestInput
): Promise<{ exitCode: number; result: Result<IngestOutput> }> {
  // Validate required args
  if (!input.source || input.source.trim().length === 0) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: "source is required" }),
    };
  }
  if (!input.vault || input.vault.trim().length === 0) {
    return {
      exitCode: ExitCode.VAULT_PATH_INVALID,
      result: err("VAULT_PATH_INVALID", { message: "vault path is required" }),
    };
  }
  if (!input.type || !ALLOWED_TYPES.has(input.type)) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", {
        message: `Invalid type "${input.type}". Allowed: ${[...ALLOWED_TYPES].join(", ")}`,
      }),
    };
  }
  if (!input.title || input.title.trim().length === 0) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: "title is required" }),
    };
  }
  if (input.provenance && !ALLOWED_PROVENANCE.has(input.provenance)) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", {
        message: `Invalid provenance "${input.provenance}". Allowed: ${[...ALLOWED_PROVENANCE].join(", ")}`,
      }),
    };
  }

  // Determine source type and fetch content
  let sourceContent: string;
  let sourceUrl: string | null = null;

  if (isUrl(input.source)) {
    sourceUrl = input.source;

    // Run fetch-guard check
    const guardResult = runFetchGuardSync({ url: input.source });
    if (!guardResult.result.ok) {
      return {
        exitCode: ExitCode.INGEST_VALIDATION_FAILED,
        result: err("INGEST_VALIDATION_FAILED", {
          message: "source URL blocked by fetch-guard",
          guardError: guardResult.result.error,
          guardDetail: guardResult.result.detail,
        }),
      };
    }

    // Fetch content
    const fetchResult = await controlledFetch(input.source, {
      timeoutMs: 15000,
      maxBytes: 1024 * 1024, // 1 MB
      maxRedirects: 5,
    });
    if (!fetchResult.ok) {
      return {
        exitCode: ExitCode.INGEST_VALIDATION_FAILED,
        result: err("INGEST_VALIDATION_FAILED", {
          message: "failed to fetch source URL",
          fetchError: fetchResult.error,
          fetchDetail: fetchResult.detail,
        }),
      };
    }
    sourceContent = fetchResult.data.body;
  } else {
    // Local file path
    try {
      sourceContent = await readFile(input.source, "utf8");
    } catch {
      return {
        exitCode: ExitCode.FILE_NOT_FOUND,
        result: err("FILE_NOT_FOUND", { path: input.source }),
      };
    }
  }

  const sensitiveFindings = scanSensitiveContent(sourceContent, { file: input.source });
  if (sensitiveFindings.length > 0) {
    return {
      exitCode: ExitCode.SENSITIVE_CONTENT_DETECTED,
      result: err("SENSITIVE_CONTENT_DETECTED", {
        message: "source content contains sensitive authentication material; provide a redacted source before ingesting",
        findings: sensitiveFindings,
      }),
    };
  }

  // Compute sha256 of the source content
  const sha256 = createHash("sha256")
    .update(Buffer.from(sourceContent, "utf8"))
    .digest("hex");

  const today = todayIso();
  const slug = slugify(input.title);
  const tags = input.tags && input.tags.length > 0 ? input.tags : [];

  // Build paths
  const rawRelPath = `raw/articles/${slug}.md`;
  const typedDir = TYPE_DIR[input.type] ?? `${input.type}s`;
  const typedRelPath = `${typedDir}/${slug}.md`;
  const rawAbsPath = join(input.vault, rawRelPath);

  const identity = assessSourceIdentity({
    rawPath: rawRelPath,
    sourceUrl: sourceUrl ?? undefined,
    body: sourceContent,
  });
  if (identity.status === "conflict") {
    return {
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: err("INGEST_VALIDATION_FAILED", {
        message: "source identity conflict",
        raw_path: rawRelPath,
        source_url: sourceUrl,
        reasons: identity.reasons,
        pathSignals: identity.pathSignals,
        sourceSignals: identity.sourceSignals,
        bodySignals: identity.bodySignals,
      }),
    };
  }

  const resolvedRaw = await resolveRawCapture({
    path: rawAbsPath,
    sourceUrl,
    sourceContent,
    sha256,
    today,
  });
  if (!resolvedRaw.ok) {
    return {
      exitCode: resolvedRaw.error === "INGEST_VALIDATION_FAILED"
        ? ExitCode.INGEST_VALIDATION_FAILED
        : ExitCode.WRITE_FAILED,
      result: resolvedRaw,
    };
  }

  let publicationDate = resolvedRaw.data.ingested;
  let typedContent = buildTypedContent(
    input.title,
    publicationDate,
    input.type,
    tags,
    rawRelPath,
    input.provenance
  );

  // The publisher resolves and validates the final target path, so create the
  // target directory without directly writing its final page bytes.
  if (!input.dryRun) {
    try {
      await mkdir(join(input.vault, typedDir), { recursive: true });
    } catch (error: unknown) {
      return {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", { path: join(input.vault, typedDir), message: String(error) }),
      };
    }
  }

  let publication = preparePagePublicationFromContent({
    vault: input.vault,
    content: typedContent,
    target: typedRelPath,
    logNote: `ingested from ${rawRelPath}`,
    now: new Date(`${publicationDate}T00:00:00Z`),
  });
  if (!publication.ok) {
    return {
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: publication,
    };
  }

  if (input.dryRun) {
    const preview = await previewPreparedPagePublication(publication.data, input.vault);
    if (!preview.result.ok) {
      return { exitCode: preview.exitCode, result: preview.result };
    }
    if (preview.exitCode !== ExitCode.OK) {
      return {
        exitCode: preview.exitCode,
        result: err("WRITE_FAILED", { message: "publication preview returned inconsistent success state" }),
      };
    }
    return {
      exitCode: ExitCode.OK,
      result: ok({
        raw_path: rawRelPath,
        typed_path: typedRelPath,
        sha256,
        dry_run: true,
        humanHint: [
          "DRY RUN — would create:",
          `  ${rawRelPath} (sha256: ${sha256.slice(0, 12)}...)`,
          `  ${typedRelPath}`,
          `  type: ${input.type}, tags: [${tags.join(", ")}]`,
          input.provenance ? `  provenance: ${input.provenance}` : "",
        ].filter(Boolean).join("\n"),
        publication: preview.result.data,
      }),
    };
  }

  try {
    await mkdir(join(input.vault, "raw", "articles"), { recursive: true });
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: join(input.vault, "raw", "articles"), message: String(error) }),
    };
  }
  const rawWrite = await writeResolvedRaw({
    path: rawAbsPath,
    sourceUrl,
    sourceContent,
    sha256,
    today,
    capture: resolvedRaw.data,
  });
  if (!rawWrite.ok) {
    return {
      exitCode: rawWrite.error === "INGEST_VALIDATION_FAILED"
        ? ExitCode.INGEST_VALIDATION_FAILED
        : ExitCode.WRITE_FAILED,
      result: rawWrite,
    };
  }

  if (rawWrite.data.capture.ingested !== publicationDate) {
    publicationDate = rawWrite.data.capture.ingested;
    typedContent = buildTypedContent(
      input.title,
      publicationDate,
      input.type,
      tags,
      rawRelPath,
      input.provenance,
    );
    publication = preparePagePublicationFromContent({
      vault: input.vault,
      content: typedContent,
      target: typedRelPath,
      logNote: `ingested from ${rawRelPath}`,
      now: new Date(`${publicationDate}T00:00:00Z`),
    });
    if (!publication.ok) {
      return {
        exitCode: ExitCode.INGEST_VALIDATION_FAILED,
        result: publication,
      };
    }
  }

  const published = await publishPreparedPage(publication.data, input.vault);
  if (!published.result.ok) {
    return { exitCode: published.exitCode, result: published.result };
  }
  if (published.exitCode !== ExitCode.OK) {
    return {
      exitCode: published.exitCode,
      result: err("WRITE_FAILED", { message: "publisher returned inconsistent success state" }),
    };
  }

  const changedFiles = [
    ...(rawWrite.data.changed ? [rawRelPath] : []),
    ...published.result.data.files_changed,
  ];
  if (changedFiles.length > 0) {
    appendLastOp(input.vault, {
      operation: "ingest",
      summary: `added ${slug}`,
      files: [...new Set(changedFiles)],
      timestamp: new Date().toISOString(),
    });
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      raw_path: rawRelPath,
      typed_path: typedRelPath,
      sha256,
      dry_run: false,
      humanHint: [
        "created:",
        `  ${rawRelPath} (sha256: ${sha256.slice(0, 12)}...)`,
        `  ${typedRelPath}`,
      ].join("\n"),
      publication: published.result.data,
    }),
  };
}
