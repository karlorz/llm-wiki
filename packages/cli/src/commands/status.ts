import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanVault } from "../utils/vault.js";
import { resolveLang } from "../utils/lang.js";

export interface StatusInput {
  vault: string;
  home: string;
  langEnvValue: string | undefined;
}

export interface StatusOutput {
  vault_path: string;
  schema_version: string;
  lang: string;
  page_counts: {
    entities: number;
    concepts: number;
    comparisons: number;
    queries: number;
    meta: number;
    raw_articles: number;
    raw_transcripts: number;
    work_items: number;
    compound: number;
  };
  total_pages: number;
  last_modified: string;
  humanHint: string;
}

export async function runStatus(
  input: StatusInput
): Promise<{ exitCode: number; result: Result<StatusOutput> }> {
  if (!existsSync(input.vault)) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID", { vault: input.vault }) };
  }

  const scan = await scanVault(input.vault);
  if (!scan.ok) {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };
  }

  // Count typed knowledge by top-level subdirectory
  const typedCounts = { entities: 0, concepts: 0, comparisons: 0, queries: 0, meta: 0 };
  for (const page of scan.data.typedKnowledge) {
    const segment = page.relPath.split("/")[0];
    if (segment in typedCounts) {
      typedCounts[segment as keyof typeof typedCounts]++;
    }
  }

  // Count raw by subdirectory: articles (+ papers + other) vs transcripts
  let rawArticles = 0;
  let rawTranscripts = 0;
  for (const page of scan.data.raw) {
    const parts = page.relPath.split("/");
    // parts[0] = "raw", parts[1] = subdirectory
    if (parts[1] === "transcripts") rawTranscripts++;
    else rawArticles++;
  }

  const workItems = scan.data.workItems.length;
  const compound = scan.data.compound.length;

  // Read schema version from SCHEMA.md (default "v1")
  let schemaVersion = "v1";
  try {
    const schemaContent = await readFile(join(input.vault, "SCHEMA.md"), "utf8");
    const versionMatch = schemaContent.match(/version:\s*["']?([^"'\s\n]+)/i);
    if (versionMatch) schemaVersion = versionMatch[1];
  } catch { /* default to v1 */ }

  // Resolve lang from config chain
  const langResult = await resolveLang({ flag: undefined, envValue: input.langEnvValue, home: input.home });

  // Find most recently modified .md file across all categories
  const allPages = [
    ...scan.data.typedKnowledge,
    ...scan.data.raw,
    ...scan.data.workItems,
    ...scan.data.compound,
  ];
  let lastModified = "";
  let maxTime = 0;
  for (const page of allPages) {
    try {
      const st = statSync(page.absPath);
      if (st.mtimeMs > maxTime) {
        maxTime = st.mtimeMs;
        lastModified = st.mtime.toISOString();
      }
    } catch { /* skip unreadable files */ }
  }

  const pageCounts = {
    entities: typedCounts.entities,
    concepts: typedCounts.concepts,
    comparisons: typedCounts.comparisons,
    queries: typedCounts.queries,
    meta: typedCounts.meta,
    raw_articles: rawArticles,
    raw_transcripts: rawTranscripts,
    work_items: workItems,
    compound,
  };

  const totalPages = Object.values(pageCounts).reduce((a, b) => a + b, 0);
  const rawTotal = rawArticles + rawTranscripts;

  const humanHint = [
    `vault: ${input.vault}`,
    `lang: ${langResult.value}`,
    `total: ${totalPages} pages`,
    `  entities: ${pageCounts.entities}  concepts: ${pageCounts.concepts}  comparisons: ${pageCounts.comparisons}  queries: ${pageCounts.queries}  meta: ${pageCounts.meta}`,
    `  raw: ${rawTotal}  work_items: ${workItems}  compound: ${compound}`,
    `last modified: ${lastModified.slice(0, 10)}`,
  ].join("\n");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      vault_path: input.vault,
      schema_version: schemaVersion,
      lang: langResult.canonical,
      page_counts: pageCounts,
      total_pages: totalPages,
      last_modified: lastModified,
      humanHint,
    }),
  };
}
