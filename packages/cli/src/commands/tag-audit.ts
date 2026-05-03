import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { extractTaxonomy } from "../parsers/taxonomy.js";

export interface TagAuditInput { vault: string }
export interface TagAuditOutput {
  violations: Array<{ page: string; tag: string }>;
  taxonomy: string[];
}

export async function runTagAudit(input: TagAuditInput): Promise<{ exitCode: number; result: Result<TagAuditOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const schemaText = await readFile(join(input.vault, "SCHEMA.md"), "utf8");
  const tax = extractTaxonomy(schemaText);
  if (!tax.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: tax };

  const allowed = new Set(tax.data);
  const violations: TagAuditOutput["violations"] = [];

  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const fm = extractFrontmatter(text);
    if (!fm.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
    const tags = fm.data.tags;
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      if (typeof t === "string" && !allowed.has(t)) {
        violations.push({ page: p.relPath, tag: t });
      }
    }
  }

  if (violations.length > 0) {
    return { exitCode: ExitCode.TAG_NOT_IN_TAXONOMY, result: ok({ violations, taxonomy: tax.data }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ violations, taxonomy: tax.data }) };
}
