import { writeFile } from "node:fs/promises";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { extractCitationMarkers, hasSourcesFooter } from "../parsers/citations.js";

export interface MigrateCitationsInput {
  vault: string;
  dryRun: boolean;
}

export interface MigrateCitationsOutput {
  scanned: number;
  migrated: string[];
  skipped: string[];
  unchanged: number;
  humanHint: string;
}

const MARKER_RE = /\^\[(raw\/[^\]]+)\]/g;

function moveMarkersToParagraphEnd(body: string): string {
  const lines = body.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      // Find matching closing fence and push all lines as-is
      result.push(line);
      if (!line.trimEnd().endsWith("```") || line.trim() === "```") {
        for (let j = i + 1; j < lines.length; j++) {
          result.push(lines[j]);
          if (lines[j].trimStart().startsWith("```")) { i = j; break; }
        }
      }
      continue;
    }

    if (/^## Sources\b/.test(line.trim())) { result.push(line); continue; }

    const markers = [...line.matchAll(MARKER_RE)];
    if (markers.length === 0) { result.push(line); continue; }

    // Check if this line is marker-only (no prose)
    const proseOnly = line.replace(MARKER_RE, "").trim();
    if (proseOnly.length === 0) {
      // Marker-only line: merge with the preceding non-empty line
      const markerStr = " " + markers.map(m => m[0]).join(" ");
      let merged = false;
      for (let k = result.length - 1; k >= 0; k--) {
        if (result[k].trim().length > 0) {
          result[k] = result[k].trimEnd() + markerStr;
          merged = true;
          break;
        }
      }
      if (!merged) result.push(line); // no preceding line to merge with
      continue;
    }

    // Line has prose + markers: check if markers are already at end
    const lastMarkerIdx = line.lastIndexOf("^[raw/");
    const afterLast = line.slice(lastMarkerIdx).replace(MARKER_RE, "").trim();
    const firstMarkerIdx = line.indexOf("^[raw/");
    const beforeFirst = line.slice(0, firstMarkerIdx).trim();
    const alreadyAtEnd = afterLast.length === 0 &&
      (beforeFirst.length === 0 || /[.!?]\s*$/.test(beforeFirst));

    if (alreadyAtEnd) { result.push(line); continue; }

    // Markers are mid-line: move to end
    let cleaned = line.replace(/\s*\^\[raw\/[^\]]+\]\s*/g, " ").trimEnd();
    cleaned = cleaned.replace(/  +/g, " ").trimEnd();
    const markerStrings = markers.map(m => m[0]);
    if (cleaned.length > 0 && /[.!?]$/.test(cleaned)) {
      cleaned += " " + markerStrings.join(" ");
    } else if (cleaned.length > 0) {
      cleaned += ". " + markerStrings.join(" ");
    } else {
      cleaned = markerStrings.join(" ");
    }
    result.push(cleaned);
  }

  return result.join("\n");
}

function buildSourcesFooter(targets: string[]): string {
  return "\n## Sources\n" + targets.map(t => `- ^[${t}]`).join("\n") + "\n";
}

function reorderSourcesFm(rawFm: string, targets: string[]): string {
  const sourcesLineRe = /^sources:\s*\[([^\]]*)\]\s*$/m;
  const match = rawFm.match(sourcesLineRe);
  if (!match) return rawFm;

  const existing = match[1]
    .split(",")
    .map(s => s.trim().replace(/^["']|["']$/g, ""))
    .filter(s => s.length > 0);

  const targetSet = new Set(targets);
  const reordered = [
    ...targets,
    ...existing.filter(s => !targetSet.has(s))
  ];

  const newLine = `sources: [${reordered.join(", ")}]`;
  return rawFm.replace(sourcesLineRe, newLine);
}

function removeExistingFooter(body: string): string {
  const footerRe = /\n## Sources\n[\s\S]*$/;
  return body.replace(footerRe, "");
}

export async function runMigrateCitations(input: MigrateCitationsInput): Promise<{ exitCode: number; result: Result<MigrateCitationsOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const migrated: string[] = [];
  const skipped: string[] = [];
  let unchanged = 0;

  for (const page of scan.data.typedKnowledge) {
    const text = await readPage(page);
    const split = splitFrontmatter(text);
    if (!split.ok) continue;

    const { rawFrontmatter, body } = split.data;
    const markers = extractCitationMarkers(body);
    if (markers.length === 0) { unchanged++; continue; }

    const bodyWithoutFooter = removeExistingFooter(body);
    const migratedBody = moveMarkersToParagraphEnd(bodyWithoutFooter);

    const seen = new Set<string>();
    const uniqueTargets: string[] = [];
    for (const m of extractCitationMarkers(migratedBody)) {
      if (!seen.has(m.target)) { seen.add(m.target); uniqueTargets.push(m.target); }
    }

    const newFooter = buildSourcesFooter(uniqueTargets);
    const newFm = reorderSourcesFm(rawFrontmatter, uniqueTargets);
    const newText = `---\n${newFm}\n---\n${migratedBody}${newFooter}`;

    if (newText === text) { skipped.push(page.relPath); continue; }

    if (!input.dryRun) {
      await writeFile(page.absPath, newText, "utf8");
    }
    migrated.push(page.relPath);
  }

  const exitCode = migrated.length > 0 ? ExitCode.MIGRATION_APPLIED : ExitCode.OK;
  const hintLines = [`scanned: ${migrated.length + skipped.length + unchanged}`];
  if (migrated.length > 0) hintLines.push(`migrated: ${migrated.length}`);
  if (skipped.length > 0) hintLines.push(`skipped (already clean): ${skipped.length}`);
  if (unchanged > 0) hintLines.push(`unchanged (no markers): ${unchanged}`);

  return {
    exitCode,
    result: ok({
      scanned: migrated.length + skipped.length + unchanged,
      migrated,
      skipped,
      unchanged,
      humanHint: hintLines.join("\n")
    })
  };
}
