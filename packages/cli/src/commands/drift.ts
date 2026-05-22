import { createHash } from "node:crypto";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import { controlledFetch, type FetchOptions } from "../utils/fetch.js";
import { safeWritePage } from "../utils/safe-write.js";

const FETCH_OPTS: FetchOptions = { timeoutMs: 10000, maxBytes: 5_000_000, maxRedirects: 5 };

export interface DriftInput {
  vault: string;
  apply?: boolean;
  newSince?: string;
  fetchFn?: (url: string, opts: FetchOptions) => Promise<Result<{ body: string }>>;
}

export interface DriftSource {
  raw_path: string;
  source_url: string;
  stored_sha256: string;
  current_sha256: string | null;
  status: "drifted" | "fetch_failed" | "unchanged" | "updated" | "new";
  fetch_error?: string;
  ingested?: string;
}

export interface DriftOutput {
  scanned: number;
  drifted: DriftSource[];
  fetch_failed: DriftSource[];
  updated: DriftSource[];
  newFiles: DriftSource[];
  unchanged: number;
  humanHint: string;
}

export async function runDrift(input: DriftInput): Promise<{ exitCode: number; result: Result<DriftOutput> }> {
  const doFetch = input.fetchFn ?? controlledFetch;

  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const results: DriftSource[] = [];
  const newResults: DriftSource[] = [];

  for (const raw of scan.data.raw) {
    const text = await readPage(raw);
    const split = splitFrontmatter(text);
    if (!split.ok) continue;
    const { rawFrontmatter, body } = split.data;

    const ingestedMatch = rawFrontmatter.match(/^ingested:\s*(.+)$/m);
    const ingestedRaw = ingestedMatch?.[1]?.trim() ?? "";
    const ingested = ingestedRaw.replace(/^["']|["']$/g, "");

    // --new: report raw files ingested on/after the given date
    if (input.newSince && ingested && ingested >= input.newSince) {
      newResults.push({
        raw_path: raw.relPath,
        source_url: "",
        stored_sha256: "",
        current_sha256: null,
        status: "new",
        ingested,
      });
    }

    const sourceUrlMatch = rawFrontmatter.match(/^source_url:\s*(.+)$/m);
    const storedHashMatch = rawFrontmatter.match(/^sha256:\s*([a-f0-9]+)$/m);
    if (!sourceUrlMatch || !storedHashMatch) continue;

    const sourceUrl = sourceUrlMatch[1]!.trim();
    const storedHash = storedHashMatch[1]!;

    // Skip source_urls that aren't HTTP — vault-internal refs aren't fetchable
    if (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://")) continue;

    // Skip files marked as non-refreshable (e.g. non-deterministic upstream)
    if (/^refreshable:\s*false\b/m.test(rawFrontmatter)) continue;

    const resp = await doFetch(sourceUrl, FETCH_OPTS);
    if (!resp.ok) {
      results.push({
        raw_path: raw.relPath,
        source_url: sourceUrl,
        stored_sha256: storedHash,
        current_sha256: null,
        status: "fetch_failed",
        fetch_error: resp.error,
      });
      continue;
    }

    const currentHash = createHash("sha256").update(Buffer.from(resp.data.body, "utf8")).digest("hex");
    const drifted = currentHash !== storedHash;

    if (drifted && input.apply) {
      // Update sha256 in frontmatter and write back
      const newFm = rawFrontmatter.replace(/^sha256:\s*[a-f0-9]+$/m, `sha256: ${currentHash}`);
      const newText = `---\n${newFm}\n---\n${body}`;
      await safeWritePage(raw.absPath, newText);
      results.push({
        raw_path: raw.relPath,
        source_url: sourceUrl,
        stored_sha256: storedHash,
        current_sha256: currentHash,
        status: "updated",
      });
    } else {
      results.push({
        raw_path: raw.relPath,
        source_url: sourceUrl,
        stored_sha256: storedHash,
        current_sha256: currentHash,
        status: drifted ? "drifted" : "unchanged",
      });
    }
  }

  const drifted = results.filter(r => r.status === "drifted");
  const fetchFailed = results.filter(r => r.status === "fetch_failed");
  const updated = results.filter(r => r.status === "updated");
  const unchanged = results.filter(r => r.status === "unchanged").length;

  // Exit 32 if drift detected (not fixed); exit 0 if no drift or all updated via --apply
  const exitCode = drifted.length > 0 ? ExitCode.DRIFT_DETECTED : ExitCode.OK;

  const hintLines: string[] = [`scanned: ${results.length}, unchanged: ${unchanged}`];
  if (newResults.length > 0) hintLines.push(`new: ${newResults.length}`, ...newResults.map(n => `  ${n.raw_path} (ingested: ${n.ingested})`));
  if (drifted.length > 0) hintLines.push(`drifted: ${drifted.length}`, ...drifted.map(d => `  ${d.raw_path}`));
  if (fetchFailed.length > 0) hintLines.push(`fetch_failed: ${fetchFailed.length}`, ...fetchFailed.map(f => `  ${f.raw_path}: ${f.fetch_error}`));
  if (updated.length > 0) hintLines.push(`updated: ${updated.length}`, ...updated.map(u => `  ${u.raw_path}`));

  // Append last-op for drift-apply mutations
  if (input.apply && updated.length > 0) {
    appendLastOp(input.vault, {
      operation: "drift-apply",
      summary: `updated ${updated.length} raw sources`,
      files: updated.map(u => u.raw_path),
      timestamp: new Date().toISOString(),
    });
  }

  return {
    exitCode,
    result: ok({ scanned: results.length, drifted, fetch_failed: fetchFailed, updated, newFiles: newResults, unchanged, humanHint: hintLines.join("\n") }),
  };
}
