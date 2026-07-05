import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { mapWithConcurrency, readPageCached, scanVault, vaultIoConcurrency, type PageTextCache, type VaultScan } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { extractTaxonomy } from "../parsers/taxonomy.js";

export interface TagAuditInput { vault: string; scan?: VaultScan; pageTextCache?: PageTextCache }
export interface TagAuditOutput {
  violations: Array<{ page: string; tag: string }>;
  taxonomy: string[];
  humanHint: string;
}

export async function runTagAudit(input: TagAuditInput): Promise<{ exitCode: number; result: Result<TagAuditOutput> }> {
  const scanResult = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanResult.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scanResult };
  const scan = scanResult.data;

  const schemaText = await readFile(join(input.vault, "SCHEMA.md"), "utf8");
  const tax = extractTaxonomy(schemaText);
  if (!tax.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: tax };

  const allowed = new Set(tax.data);
  const violations: TagAuditOutput["violations"] = [];

  const perPage = await mapWithConcurrency(scan.typedKnowledge, vaultIoConcurrency(), async (p) => {
    const text = await readPageCached(p, input.pageTextCache);
    const fm = extractFrontmatter(text);
    if (!fm.ok) return fm;
    const pageViolations: TagAuditOutput["violations"] = [];
    const tags = fm.data.tags;
    if (!Array.isArray(tags)) return pageViolations;
    for (const t of tags) {
      if (typeof t === "string" && !allowed.has(t)) {
        pageViolations.push({ page: p.relPath, tag: t });
      }
    }
    return pageViolations;
  });

  for (const result of perPage) {
    if (!Array.isArray(result)) {
      return { exitCode: ExitCode.INVALID_FRONTMATTER, result };
    }
    violations.push(...result);
  }

  if (violations.length > 0) {
    return { exitCode: ExitCode.TAG_NOT_IN_TAXONOMY, result: ok({ violations, taxonomy: tax.data, humanHint: violations.map(v => `${v.page}: "${v.tag}" not in taxonomy`).join("\n") }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ violations, taxonomy: tax.data, humanHint: "all tags valid" }) };
}
