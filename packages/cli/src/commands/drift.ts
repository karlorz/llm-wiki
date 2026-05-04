import { createHash } from "node:crypto";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { controlledFetch, type FetchOptions } from "../utils/fetch.js";

const FETCH_OPTS: FetchOptions = { timeoutMs: 10000, maxBytes: 5_000_000, maxRedirects: 5 };

export interface DriftInput {
  vault: string;
  fetchFn?: (url: string, opts: FetchOptions) => Promise<Result<{ body: string }>>;
}

export interface DriftSource {
  raw_path: string;
  source_url: string;
  stored_sha256: string;
  current_sha256: string | null;
  status: "drifted" | "fetch_failed" | "unchanged";
  fetch_error?: string;
}

export interface DriftOutput {
  scanned: number;
  drifted: DriftSource[];
  fetch_failed: DriftSource[];
  unchanged: number;
}

export async function runDrift(input: DriftInput): Promise<{ exitCode: number; result: Result<DriftOutput> }> {
  const doFetch = input.fetchFn ?? controlledFetch;

  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const results: DriftSource[] = [];

  for (const raw of scan.data.raw) {
    const fm = extractFrontmatter(await readPage(raw));
    if (!fm.ok) continue;
    const sourceUrl = typeof fm.data.source_url === "string" ? fm.data.source_url : null;
    const storedHash = typeof fm.data.sha256 === "string" ? fm.data.sha256 : null;
    if (!sourceUrl || !storedHash) continue;

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
    results.push({
      raw_path: raw.relPath,
      source_url: sourceUrl,
      stored_sha256: storedHash,
      current_sha256: currentHash,
      status: drifted ? "drifted" : "unchanged",
    });
  }

  const drifted = results.filter(r => r.status === "drifted");
  const fetchFailed = results.filter(r => r.status === "fetch_failed");
  const unchanged = results.filter(r => r.status === "unchanged").length;

  const exitCode = drifted.length > 0 ? ExitCode.DRIFT_DETECTED : ExitCode.OK;
  return {
    exitCode,
    result: ok({ scanned: results.length, drifted, fetch_failed: fetchFailed, unchanged }),
  };
}
