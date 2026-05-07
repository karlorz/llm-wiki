import { rename, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";

export interface ArchiveInput { vault: string; page: string }
export interface ArchiveOutput {
  archived_from: string;
  archived_to: string;
  index_updated: boolean;
  humanHint: string;
}

export async function runArchive(input: ArchiveInput): Promise<{ exitCode: number; result: Result<ArchiveOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const lookup = (pages: { relPath: string }[]) => {
    if (input.page.includes("/")) return pages.find(p => p.relPath === input.page)?.relPath;
    return pages.find(p => p.relPath.replace(/\.md$/, "").split("/").pop() === input.page)?.relPath;
  };

  let relPath = lookup(scan.data.typedKnowledge);
  let isRaw = false;
  if (!relPath) {
    relPath = lookup(scan.data.raw);
    isRaw = relPath != null;
  }

  if (!relPath) return { exitCode: ExitCode.ARCHIVE_TARGET_NOT_FOUND, result: err("ARCHIVE_TARGET_NOT_FOUND", { page: input.page }) };

  if (relPath.startsWith("_archive/")) return { exitCode: ExitCode.ARCHIVE_ALREADY_ARCHIVED, result: err("ARCHIVE_ALREADY_ARCHIVED", { page: relPath }) };

  const archivePath = join("_archive", relPath);
  await mkdir(dirname(join(input.vault, archivePath)), { recursive: true });

  let indexUpdated = false;
  if (!isRaw) {
    const indexPath = join(input.vault, "index.md");
    try {
      const idx = await readFile(indexPath, "utf8");
      const slug = relPath.replace(/\.md$/, "").split("/").pop()!;
      const originalLines = idx.split("\n");
      const filtered = originalLines.filter(l => !l.includes(`[[${slug}]]`));
      if (filtered.length !== originalLines.length) {
        await writeFile(indexPath, filtered.join("\n"), "utf8");
        indexUpdated = true;
      }
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }

  await rename(join(input.vault, relPath), join(input.vault, archivePath));

  return { exitCode: ExitCode.OK, result: ok({ archived_from: relPath, archived_to: archivePath, index_updated: indexUpdated, humanHint: `${relPath} -> ${archivePath}${indexUpdated ? " (index updated)" : ""}` }) };
}
