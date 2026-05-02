import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { extractCitationMarkers } from "../parsers/citations.js";

export interface AuditInput { file: string }
export interface AuditOutput {
  markers: Array<{ marker: string; target: string; resolved: boolean }>;
  sources_consistency: { unused_sources: string[]; missing_from_sources: string[] };
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
    try { await stat(join(vault, m.target)); return { ...m, resolved: true }; }
    catch { return { ...m, resolved: false }; }
  }));

  const sources = (fm.data.sources as string[] | undefined) ?? [];
  const referenced = new Set(resolved.map(m => m.target));
  const unused_sources = sources.filter(s => !referenced.has(s));
  const missing_from_sources = [...referenced].filter(t => !sources.includes(t));

  if (resolved.some(m => !m.resolved)) {
    return { exitCode: ExitCode.UNRESOLVED_MARKERS, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
  }
  if (unused_sources.length > 0 || missing_from_sources.length > 0) {
    return { exitCode: ExitCode.SOURCES_INCONSISTENT, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
  }
  return { exitCode: ExitCode.OK, result: ok({ markers: resolved, sources_consistency: { unused_sources, missing_from_sources } }) };
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
