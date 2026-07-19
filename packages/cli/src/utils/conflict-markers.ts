import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ConflictMarkerFinding = { path: string; line: number };

export function scanConflictMarkerBlocksInText(
  relPath: string,
  text: string,
): ConflictMarkerFinding[] {
  const findings: ConflictMarkerFinding[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  let openLine = 0;
  let sawSeparator = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.startsWith("<<<<<<< ")) {
      openLine = i + 1;
      sawSeparator = false;
      continue;
    }
    if (line === "=======" && openLine > 0) {
      sawSeparator = true;
      continue;
    }
    if (line.startsWith(">>>>>>> ")) {
      if (openLine > 0 && sawSeparator) {
        findings.push({ path: relPath, line: openLine });
      }
      openLine = 0;
      sawSeparator = false;
    }
  }

  return findings;
}

const PRUNE_DIRS = new Set([
  ".git",
  ".obsidian",
  ".skillwiki",
  ".claude",
  ".antigravitycli",
  ".playwright-cli",
]);

function walkMarkdownFiles(root: string, dir: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (PRUNE_DIRS.has(entry.name)) continue;
      walkMarkdownFiles(root, join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
}

/** Scan a vault root for complete Git conflict-marker blocks in Markdown (ignores fenced code). */
export function scanVaultConflictMarkers(vaultRoot: string): ConflictMarkerFinding[] {
  if (!existsSync(vaultRoot)) return [];
  const relPaths: string[] = [];
  walkMarkdownFiles(vaultRoot, vaultRoot, "", relPaths);
  const all: ConflictMarkerFinding[] = [];
  for (const rel of relPaths) {
    let text: string;
    try {
      text = readFileSync(join(vaultRoot, rel), "utf8");
    } catch {
      continue;
    }
    all.push(...scanConflictMarkerBlocksInText(rel, text));
  }
  return all;
}
