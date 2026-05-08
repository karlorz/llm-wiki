import { writeFile } from "node:fs/promises";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { splitFrontmatter } from "../parsers/frontmatter.js";

export interface TagSyncInput {
  vault: string;
  dryRun: boolean;
}

export interface TagSyncOutput {
  scanned: number;
  synced: string[];
  unchanged: number;
  humanHint: string;
}

/** Frontmatter enum fields that should be mirrored to nested tags. */
const ENUM_MIRRORS: Record<string, string[]> = {
  provenance: ["research", "project", "mixed"],
  confidence: ["high", "medium", "low"],
};

/** Convert a frontmatter value to a nested tag: provenance → #provenance/project */
function toNestedTag(field: string, value: string): string {
  return `${field}/${value}`;
}

/** Compute the set of nested tags that should exist based on frontmatter enum values. */
function expectedNestedTags(fm: Record<string, unknown>): Set<string> {
  const expected = new Set<string>();
  for (const [field, allowedValues] of Object.entries(ENUM_MIRRORS)) {
    const value = fm[field];
    if (typeof value === "string" && allowedValues.includes(value)) {
      expected.add(toNestedTag(field, value));
    }
  }
  return expected;
}

/** Parse the tags array from raw frontmatter YAML (supports both inline [] and multi-line - item formats). */
function parseTagsFromYaml(rawFm: string): string[] {
  // Try inline format: tags: [a, b, c]
  const inlineMatch = rawFm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]!.split(",").map(t => t.trim().replace(/^['"]|['"]$/g, "")).filter(t => t.length > 0);
  }
  // Try multi-line format: tags:\n  - a\n  - b
  // Only consume lines that start with "  - " and stop at the first non-list-item line
  const lines = rawFm.split("\n");
  const tagItems: string[] = [];
  let inTags = false;
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      continue;
    }
    if (inTags) {
      if (/^\s+-\s+/.test(line) && !/^\s+-\s+\[\[/.test(line)) {
        // Looks like a tag item (but not a wikilink like - [[...]])
        const value = line.replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, "");
        if (value.length > 0) tagItems.push(value);
      } else {
        // End of tags list
        break;
      }
    }
  }
  return tagItems;
}

/** Rebuild the tags section in raw frontmatter YAML with new tags added. */
function rebuildTagsSection(rawFm: string, existingTags: string[], toAdd: string[]): string {
  const allTags = [...existingTags, ...toAdd];
  const tagsLine = `tags: [${allTags.join(", ")}]`;
  // Replace inline format: tags: [a, b, c]
  if (/^tags:\s*\[/m.test(rawFm)) {
    return rawFm.replace(/^tags:\s*\[[^\]]*\]/m, tagsLine);
  }
  // Replace multi-line format: tags:\n  - a\n  - b (stop at non-list-item)
  const lines = rawFm.split("\n");
  const out: string[] = [];
  let inTags = false;
  let tagsReplaced = false;
  for (const line of lines) {
    if (/^tags:\s*$/.test(line)) {
      inTags = true;
      if (!tagsReplaced) {
        out.push(tagsLine);
        tagsReplaced = true;
      }
      continue;
    }
    if (inTags) {
      if (/^\s+-\s+/.test(line) && !/^\s+-\s+\[\[/.test(line)) {
        // Skip old multi-line tag items
        continue;
      } else {
        inTags = false;
      }
    }
    out.push(line);
  }
  // If tags line was never found, append one
  if (!tagsReplaced) {
    out.push(tagsLine);
  }
  return out.join("\n");
}

export async function runTagSync(input: TagSyncInput): Promise<{ exitCode: number; result: Result<TagSyncOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const synced: string[] = [];
  let unchanged = 0;

  for (const page of scan.data.typedKnowledge) {
    const text = await readPage(page);
    const split = splitFrontmatter(text);
    if (!split.ok) { unchanged++; continue; }

    const { rawFrontmatter, body } = split.data;

    // Parse frontmatter values (lightweight — no zod, just enum matching)
    const fm: Record<string, unknown> = {};
    for (const [field, allowedValues] of Object.entries(ENUM_MIRRORS)) {
      for (const v of allowedValues) {
        if (rawFrontmatter.includes(`${field}: ${v}`)) {
          fm[field] = v;
          break;
        }
      }
    }

    const expected = expectedNestedTags(fm);
    if (expected.size === 0) { unchanged++; continue; }

    const existingTags = parseTagsFromYaml(rawFrontmatter);
    const existingSet = new Set(existingTags);

    const toAdd = [...expected].filter(t => !existingSet.has(t));
    if (toAdd.length === 0) { unchanged++; continue; }

    const newFm = rebuildTagsSection(rawFrontmatter, existingTags, toAdd);
    const newText = `---\n${newFm}\n---\n${body}`;

    if (!input.dryRun) {
      await writeFile(page.absPath, newText, "utf8");
    }
    synced.push(page.relPath);
  }

  const exitCode = synced.length > 0 ? ExitCode.MIGRATION_APPLIED : ExitCode.OK;
  const hintLines = [`scanned: ${synced.length + unchanged}`];
  if (synced.length > 0) hintLines.push(`synced: ${synced.length}`);
  if (unchanged > 0) hintLines.push(`unchanged: ${unchanged}`);
  if (input.dryRun && synced.length > 0) hintLines.push("(dry run — no files written)");

  return {
    exitCode,
    result: ok({
      scanned: synced.length + unchanged,
      synced,
      unchanged,
      humanHint: hintLines.join("\n"),
    }),
  };
}
