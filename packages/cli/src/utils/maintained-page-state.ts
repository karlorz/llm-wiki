import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { VaultPage } from "./vault.js";

export async function snapshotMaintainedPageState(pages: readonly VaultPage[]): Promise<string[]> {
  const entries = await Promise.all(
    pages
      .filter(page => !page.relPath.startsWith("raw/"))
      .map(async page => {
        const bytes = await readFile(page.absPath);
        return `${page.relPath}:${createHash("sha256").update(bytes).digest("hex")}`;
      }),
  );
  return entries.sort();
}
