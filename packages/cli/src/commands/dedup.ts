import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";

export interface DedupInput {
  vault: string;
}

export interface DedupPair {
  sha256: string;
  files: string[];
}

export interface DedupOutput {
  scanned: number;
  duplicates: DedupPair[];
  humanHint: string;
}

export async function runDedup(input: DedupInput): Promise<{ exitCode: number; result: Result<DedupOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const hashMap = new Map<string, string[]>();
  let totalFiles = 0;

  for (const raw of scan.data.raw) {
    const fm = extractFrontmatter(await readPage(raw));
    if (!fm.ok) continue;
    const sha = typeof fm.data.sha256 === "string" ? fm.data.sha256 : null;
    if (!sha || sha.length !== 64) continue;

    totalFiles++;
    const existing = hashMap.get(sha);
    if (existing) existing.push(raw.relPath);
    else hashMap.set(sha, [raw.relPath]);
  }

  const duplicates = [...hashMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({ sha256, files }));

  const exitCode = duplicates.length > 0 ? ExitCode.RAW_DEDUP_DETECTED : ExitCode.OK;
  const hintLines: string[] = [`scanned: ${totalFiles} raw files`];
  if (duplicates.length > 0) {
    hintLines.push(`duplicates: ${duplicates.length}`);
    for (const d of duplicates) hintLines.push(`  ${d.sha256.slice(0, 12)}... → ${d.files.join(", ")}`);
  } else {
    hintLines.push("0 duplicates");
  }

  return {
    exitCode,
    result: ok({ scanned: totalFiles, duplicates, humanHint: hintLines.join("\n") }),
  };
}
