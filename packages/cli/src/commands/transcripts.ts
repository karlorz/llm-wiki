import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface TranscriptsInput {
  vault: string;
  since?: string;
}

export interface TranscriptEntry {
  file: string;
  ingested: string;
  size: number;
}

export interface TranscriptsOutput {
  transcripts: TranscriptEntry[];
  humanHint: string;
}

export async function runTranscripts(input: TranscriptsInput): Promise<{ exitCode: number; result: Result<TranscriptsOutput> }> {
  const dir = join(input.vault, "raw", "transcripts");
  let entries: Array<{ name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { exitCode: ExitCode.VAULT_PATH_INVALID, result: { ok: false, error: "VAULT_PATH_INVALID", detail: `raw/transcripts/ not found: ${dir}` } };
  }

  const transcripts: TranscriptEntry[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const content = await readFile(filePath, "utf8");
    const fm = extractFrontmatter(content);
    if (!fm.ok) continue;

    const ingested = typeof fm.data.ingested === "string" ? fm.data.ingested : "";
    if (input.since && ingested && ingested < input.since) continue;

    const s = await stat(filePath);
    transcripts.push({
      file: `raw/transcripts/${entry.name}`,
      ingested,
      size: s.size,
    });
  }

  const hint = transcripts.length > 0
    ? transcripts.map(t => `${t.file} (ingested: ${t.ingested || "unknown"}, ${t.size}B)`).join("\n")
    : "no transcript files found";

  return { exitCode: ExitCode.OK, result: ok({ transcripts, humanHint: hint }) };
}
