import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { createHash } from "node:crypto";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter, extractFrontmatter } from "../parsers/frontmatter.js";

export interface BodyDupGroup {
  bodyHash: string;
  files: { relPath: string; sha256: string | null }[];
}

export interface RawBodyDedupOutput {
  scanned: number;
  duplicates: BodyDupGroup[];
}

export async function runRawBodyDedup(vault: string): Promise<{ exitCode: number; result: Result<RawBodyDedupOutput> }> {
  const scan = await scanVault(vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const bodyHashMap = new Map<string, { relPath: string; sha256: string | null }[]>();
  let totalFiles = 0;

  for (const raw of scan.data.raw) {
    const text = await readPage(raw);
    const split = splitFrontmatter(text);
    if (!split.ok) continue;

    totalFiles++;

    // Hash body content only (excluding frontmatter)
    const bodyHash = createHash("sha256").update(split.data.body).digest("hex");

    // Extract frontmatter sha256 via YAML parser (not regex — handles quoted values, whitespace, etc.)
    const fm = extractFrontmatter(text);
    let fmSha256: string | null = null;
    if (fm.ok && typeof fm.data.sha256 === "string" && fm.data.sha256.length === 64) {
      fmSha256 = fm.data.sha256;
    }

    const existing = bodyHashMap.get(bodyHash);
    if (existing) {
      existing.push({ relPath: raw.relPath, sha256: fmSha256 });
    } else {
      bodyHashMap.set(bodyHash, [{ relPath: raw.relPath, sha256: fmSha256 }]);
    }
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
