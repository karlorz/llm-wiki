import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { runFetchGuardSync } from "./fetch-guard.js";
import { controlledFetch } from "../utils/fetch.js";
import { appendLastOp } from "../utils/last-op.js";
import { assessSourceIdentity } from "../utils/source-identity.js";
import {
  TypedKnowledgeSchema,
  RawSourceSchema,
  detectSchema,
  type SchemaName,
} from "@skillwiki/shared";

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

  const fm: Record<string, unknown> = {
    title,
    aliases,
    created: ingested,
    updated: ingested,
    type,
    tags,
    sources: [rawRelPath],
    confidence: "medium",
  };
  if (provenance) {
    fm.provenance = provenance;
  }

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
  const typedAbsPath = join(input.vault, typedRelPath);

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

  // Build file contents
  const rawContent = buildRawContent(sourceUrl, today, sha256, sourceContent);

  const typedContent = buildTypedContent(
    input.title,
    today,
    input.type,
    tags,
    rawRelPath,
    input.provenance
  );

  // Dry-run: return what would be created without writing
  if (input.dryRun) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        raw_path: rawRelPath,
        typed_path: typedRelPath,
        sha256,
        dry_run: true,
        humanHint: [
          `DRY RUN — would create:`,
          `  ${rawRelPath} (sha256: ${sha256.slice(0, 12)}...)`,
          `  ${typedRelPath}`,
          `  type: ${input.type}, tags: [${tags.join(", ")}]`,
          input.provenance ? `  provenance: ${input.provenance}` : "",
        ].filter(Boolean).join("\n"),
      }),
    };
  }

  // Validate the typed-knowledge page against the schema
  const typedFm = {
    title: input.title,
    aliases: [],
    created: today,
    updated: today,
    type: input.type,
    tags,
    sources: [rawRelPath],
    confidence: "medium",
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };

  const det = detectSchema(typedFm);
  if (!det.schema) {
    return {
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: err("INGEST_VALIDATION_FAILED", {
        message: "generated typed-knowledge page could not be detected as a valid schema",
      }),
    };
  }
  const parsed = TypedKnowledgeSchema.safeParse(typedFm);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return {
      exitCode: ExitCode.INGEST_VALIDATION_FAILED,
      result: err("INGEST_VALIDATION_FAILED", {
        message: "generated typed-knowledge page failed schema validation",
        errors,
      }),
    };
  }

  // Write raw file
  try {
    await mkdir(join(input.vault, "raw", "articles"), { recursive: true });
    await writeFile(rawAbsPath, rawContent, "utf8");
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: rawAbsPath, message: String(e) }),
    };
  }

  // Write typed-knowledge file
  try {
    await mkdir(join(input.vault, typedDir), { recursive: true });
    await writeFile(typedAbsPath, typedContent, "utf8");
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: typedAbsPath, message: String(e) }),
    };
  }

  const humanHint = [
    `created:`,
    `  ${rawRelPath} (sha256: ${sha256.slice(0, 12)}...)`,
    `  ${typedRelPath}`,
  ].join("\n");

  appendLastOp(input.vault, {
    operation: "ingest",
    summary: `added ${slug}`,
    files: [rawRelPath, typedRelPath],
    timestamp: new Date().toISOString(),
  });

  return {
    exitCode: ExitCode.OK,
    result: ok({
      raw_path: rawRelPath,
      typed_path: typedRelPath,
      sha256,
      dry_run: false,
      humanHint,
    }),
  };
}
