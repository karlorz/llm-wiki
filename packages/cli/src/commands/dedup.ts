import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { appendLastOp } from "../utils/last-op.js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface DedupInput {
  vault: string;
  apply?: boolean;
}

export interface DedupPair {
  sha256: string;
  files: string[];
}

export interface DedupOutput {
  scanned: number;
  duplicates: DedupPair[];
  rewired: string[];
  removed: string[];
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

  const rewired: string[] = [];
  const removed: string[] = [];

  if (input.apply && duplicates.length > 0) {
    // Build replacement map: duplicate path → canonical path (first in group)
    // relPath from scanVault includes the type prefix (e.g., "raw/articles/...")
    // Citation markers use ^[raw/...] — so the marker path is the relPath directly
    const replacements = new Map<string, string>();
    for (const group of duplicates) {
      const canonical = group.files[0]!;
      for (let i = 1; i < group.files.length; i++) {
        replacements.set(group.files[i]!, canonical);
      }
    }

    // Rewire citations in all typed-knowledge pages
    for (const page of scan.data.typedKnowledge) {
      const text = readFileSync(join(input.vault, page.relPath), "utf-8");
      let updated = text;
      let changed = false;
      for (const [oldPath, newPath] of replacements) {
        const oldMarker = `^[${oldPath}]`;
        const newMarker = `^[${newPath}]`;
        if (updated.includes(oldMarker)) {
          updated = updated.replaceAll(oldMarker, newMarker);
          changed = true;
        }
        // Also rewrite in frontmatter sources list
        const oldFm = `- "^[${oldPath}]"`;
        const newFm = `- "^[${newPath}]"`;
        if (updated.includes(oldFm)) {
          updated = updated.replaceAll(oldFm, newFm);
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(join(input.vault, page.relPath), updated);
        rewired.push(page.relPath);
      }
    }

    // Delete duplicate raw files
    for (const [oldPath] of replacements) {
      const fullPath = join(input.vault, oldPath);
      try {
        unlinkSync(fullPath);
        removed.push(oldPath);
      } catch {
        // File may already be gone; skip
      }
    }
  }

  if (input.apply && (rewired.length > 0 || removed.length > 0)) {
    appendLastOp(input.vault, {
      operation: "dedup",
      summary: `rewired ${rewired.length} pages, removed ${removed.length} duplicates`,
      files: [...rewired, ...removed],
      timestamp: new Date().toISOString(),
    });
  }

  const exitCode = duplicates.length > 0
    ? (input.apply ? ExitCode.DEDUP_APPLIED : ExitCode.RAW_DEDUP_DETECTED)
    : ExitCode.OK;
  const hintLines: string[] = [`scanned: ${totalFiles} raw files`];
  if (duplicates.length > 0) {
    hintLines.push(`duplicates: ${duplicates.length}`);
    for (const d of duplicates) hintLines.push(`  ${d.sha256.slice(0, 12)}... → ${d.files.join(", ")}`);
    if (input.apply) {
      hintLines.push(`rewired: ${rewired.length} pages`);
      hintLines.push(`removed: ${removed.length} raw files`);
    }
  } else {
    hintLines.push("0 duplicates");
  }

  return {
    exitCode,
    result: ok({ scanned: totalFiles, duplicates, rewired, removed, humanHint: hintLines.join("\n") }),
  };
}
