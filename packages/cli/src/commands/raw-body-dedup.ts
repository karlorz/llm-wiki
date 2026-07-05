import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { createHash } from "node:crypto";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { splitFrontmatter, extractFrontmatter } from "../parsers/frontmatter.js";

export interface BodyDupGroup {
  bodyHash: string;
  files: { relPath: string; sha256: string | null }[];
}

export interface RawBodyDedupOutput {
  scanned: number;
  duplicates: BodyDupGroup[];
}

export async function runRawBodyDedup(vault: string, scan?: VaultScan, pageTextCache?: PageTextCache): Promise<{ exitCode: number; result: Result<RawBodyDedupOutput> }> {
  const scanResult = scan ? ok(scan) : await scanVault(vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };

  const bodyHashMap = new Map<string, { relPath: string; sha256: string | null }[]>();
  const rawEntries = await mapWithConcurrency(scanResult.data.raw, vaultIoConcurrency(), async (raw) => {
    const text = await readPageCached(raw, pageTextCache);
    const split = splitFrontmatter(text);
    if (!split.ok) return null;

    // Hash body content only (excluding frontmatter)
    const bodyHash = createHash("sha256").update(split.data.body).digest("hex");

    // Extract frontmatter sha256 via YAML parser (not regex — handles quoted values, whitespace, etc.)
    const fm = extractFrontmatter(text);
    let fmSha256: string | null = null;
    if (fm.ok && typeof fm.data.sha256 === "string" && fm.data.sha256.length === 64) {
      fmSha256 = fm.data.sha256;
    }

    return { bodyHash, relPath: raw.relPath, sha256: fmSha256 };
  });

  let totalFiles = 0;
  for (const entry of rawEntries) {
    if (!entry) continue;
    totalFiles++;
    const existing = bodyHashMap.get(entry.bodyHash);
    if (existing) existing.push({ relPath: entry.relPath, sha256: entry.sha256 });
    else bodyHashMap.set(entry.bodyHash, [{ relPath: entry.relPath, sha256: entry.sha256 }]);
  }

  // Suppress only groups that the existing SHA256-based dedup already catches.
  // Missing/invalid SHA values still need the body duplicate warning.
  const duplicates: BodyDupGroup[] = [];
  for (const [bodyHash, files] of bodyHashMap) {
    if (files.length < 2) continue;
    const uniqueShas = new Set(files.map(f => f.sha256));
    const allHaveSameValidSha = uniqueShas.size === 1 && files.every(f => f.sha256 !== null);
    if (!allHaveSameValidSha) {
      duplicates.push({ bodyHash, files });
    }
  }

  return {
    exitCode: 0,
    result: ok({ scanned: totalFiles, duplicates }),
  };
}
