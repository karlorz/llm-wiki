import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { extractCitationMarkers } from "../parsers/citations.js";
import { scanVault, readPage, readPageCached } from "../utils/vault.js";
import type { PageTextCache, VaultPage, VaultScan } from "../utils/vault.js";
import { rawSourceTargetExists } from "../utils/raw-source.js";

export interface AuditInput { file: string }
export interface AuditOutput {
  markers: Array<{ marker: string; target: string; resolved: boolean }>;
  sources_consistency: { unused_sources: string[]; missing_from_sources: string[] };
  footer_consistency?: { missing_from_footer: string[]; extra_in_footer: string[] };
  humanHint: string;
}

export async function runAudit(input: AuditInput): Promise<{ exitCode: number; result: Result<AuditOutput> }> {
  let text: string;
  try { text = await readFile(input.file, "utf8"); }
  catch { return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) }; }

  const fm = extractFrontmatter(text);
  if (!fm.ok) return { exitCode: ExitCode.INVALID_FRONTMATTER, result: fm };
  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;

  // Find vault root by walking up to a directory containing SCHEMA.md.
  const vault = await findVaultRoot(dirname(resolve(input.file)));
  if (!vault) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: err("VAULT_PATH_INVALID") };

  const markers = extractCitationMarkers(body);
  const resolved = await Promise.all(markers.map(async m => {
    return { ...m, resolved: await rawSourceTargetExists(vault, m.target) };
  }));

  const sources = ((fm.data.sources as string[] | undefined) ?? [])
    .map(s => s.replace(/^\^\[/, "").replace(/\]$/, ""));
  const referenced = new Set(resolved.map(m => m.target));
  const unused_sources = sources.filter(s => !referenced.has(s));
  const missing_from_sources = [...referenced].filter(t => !sources.includes(t));

  const broken = resolved.filter(m => !m.resolved);

  // Footer consistency check
  const footerMatch = body.match(/\r?\n## Sources\r?\n([\s\S]*)$/);
  let footer_consistency: AuditOutput["footer_consistency"];
  if (footerMatch) {
    const footerTargets = new Set<string>();
    const footerRe = /\^\[(raw\/[^\]]+)\]/g;
    let mm: RegExpExecArray | null;
    while ((mm = footerRe.exec(footerMatch[1])) !== null) footerTargets.add(mm[1]);

    const bodyTargets = new Set(resolved.map(m => m.target));
    const missing_from_footer = [...bodyTargets].filter(t => !footerTargets.has(t));
    const extra_in_footer = [...footerTargets].filter(t => !bodyTargets.has(t));
    footer_consistency = { missing_from_footer, extra_in_footer };
  }

  const hintLines: string[] = [];
  hintLines.push(`markers: ${resolved.length}, broken: ${broken.length}`);
  if (unused_sources.length > 0) hintLines.push(`unused_sources: ${unused_sources.length}`);
  if (missing_from_sources.length > 0) hintLines.push(`missing_from_sources: ${missing_from_sources.length}`);
  if (footer_consistency) {
    if (footer_consistency.missing_from_footer.length > 0) hintLines.push(`missing_from_footer: ${footer_consistency.missing_from_footer.length}`);
    if (footer_consistency.extra_in_footer.length > 0) hintLines.push(`extra_in_footer: ${footer_consistency.extra_in_footer.length}`);
  }
  if (broken.length === 0 && unused_sources.length === 0 && missing_from_sources.length === 0) hintLines.push("OK");
  const humanHint = hintLines.join("\n");

  if (resolved.some(m => !m.resolved)) {
    return { exitCode: ExitCode.UNRESOLVED_MARKERS, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources }, footer_consistency, humanHint }) };
  }
  if (unused_sources.length > 0 || missing_from_sources.length > 0) {
    return { exitCode: ExitCode.SOURCES_INCONSISTENT, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources }, footer_consistency, humanHint }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources }, footer_consistency, humanHint }) };
}

async function findVaultRoot(start: string): Promise<string | null> {
  let cur = start;
  for (let i = 0; i < 20; i++) {
    try { await stat(join(cur, "SCHEMA.md")); return cur; } catch { /* keep walking */ }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

// --- Compound reference validation ---

export interface CompoundRefFinding {
  compound: string;
  work_item: string;
  kind: "missing" | "cross_project";
  detail: string;
}

function stripWikilink(s: string): string {
  return s.replace(/^\[\[/, "").replace(/(?:\|[^\[\]]*)?\]\]$/, "").trim();
}

export async function validateCompoundReferences(
  vault: string,
  existingScan?: VaultScan,
  pageTextCache?: PageTextCache,
): Promise<Result<CompoundRefFinding[]>> {
  const scan = existingScan ? ok(existingScan) : await scanVault(vault);
  if (!scan.ok) return scan;

  const slugToPage = new Map<string, VaultPage>();
  const pathToPage = new Map<string, VaultPage>();
  for (const p of scan.data.workItems) {
    slugToPage.set(p.relPath.replace(/\.md$/, "").split("/").pop()!.toLowerCase(), p);
    pathToPage.set(p.relPath, p);
  }

  const findings: CompoundRefFinding[] = [];
  for (const cp of scan.data.compound) {
    const text = await readPageCached(cp, pageTextCache);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;
    const projectRaw = fm.data.project as string | undefined;
    const workItems = fm.data.work_items as string[] | undefined;
    if (!projectRaw || !workItems?.length) continue;
    const projSlug = stripWikilink(String(projectRaw));

    for (const wi of workItems) {
      const target = stripWikilink(wi);
      const withExt = target.endsWith(".md") ? target : target + ".md";
      const resolved = pathToPage.get(withExt)
        ?? slugToPage.get(target.split("/").pop()!.replace(/\.md$/, "").toLowerCase());

      if (!resolved) {
        findings.push({ compound: cp.relPath, work_item: wi, kind: "missing", detail: `no work item found for [[${target}]]` });
        continue;
      }
      const wiFm = extractFrontmatter(await readPageCached(resolved, pageTextCache));
      if (wiFm.ok && wiFm.data.project) {
        const wiProj = stripWikilink(String(wiFm.data.project));
        if (wiProj !== projSlug) {
          findings.push({ compound: cp.relPath, work_item: wi, kind: "cross_project", detail: `compound project [[${projSlug}]] != work_item project [[${wiProj}]]` });
        }
      }
    }
  }
  return ok(findings);
}
