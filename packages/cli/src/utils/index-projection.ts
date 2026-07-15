import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { atomicWriteText } from "./atomic-write.js";
import { prepareTypedPage } from "./typed-page.js";
import { scanVault } from "./vault.js";

const SECTION_ORDER = ["Entities", "Concepts", "Comparisons", "Queries", "Meta", "Projects"] as const;
const TYPE_SECTION: Record<string, (typeof SECTION_ORDER)[number]> = {
  entity: "Entities",
  concept: "Concepts",
  comparison: "Comparisons",
  query: "Queries",
  meta: "Meta",
};
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const UNMANAGED_START = "<!-- skillwiki:index-unmanaged:start -->";
const UNMANAGED_END = "<!-- skillwiki:index-unmanaged:end -->";

export interface RootIndexEntry {
  section: (typeof SECTION_ORDER)[number];
  target: string;
  title: string;
  source: "typed" | "project";
}

export interface RootIndexProjection {
  text: string;
  entries: RootIndexEntry[];
  duplicates_removed: number;
  ghosts_removed: string[];
}

export interface RenderRootIndexInput {
  vault: string;
  currentText?: string;
}

function extractUnmanaged(currentText: string): Result<string> {
  const startCount = currentText.split(UNMANAGED_START).length - 1;
  const endCount = currentText.split(UNMANAGED_END).length - 1;
  if (startCount === 0 && endCount === 0) return ok("");
  if (startCount !== 1 || endCount !== 1) {
    return err("SCHEME_REJECTED", {
      message: "index.md must contain exactly one complete unmanaged marker pair",
    });
  }
  const start = currentText.indexOf(UNMANAGED_START);
  const end = currentText.indexOf(UNMANAGED_END);
  if (start < 0 || end < 0 || end < start) {
    return err("SCHEME_REJECTED", {
      message: "unmanaged marker pair is reversed or incomplete",
    });
  }
  const body = currentText.slice(start + UNMANAGED_START.length, end).replace(/^\n/, "").replace(/\n$/, "");
  return ok(body);
}

function priorWikilinkTargets(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]!.trim().replace(/\.md$/, ""));
  }
  return out;
}

function projectTitleFromReadme(text: string, slug: string): string {
  const m = text.match(/^#\s+Project:\s+(.+)$/m);
  return m?.[1]?.trim() || slug;
}

export async function renderRootIndex(
  input: RenderRootIndexInput,
): Promise<Result<RootIndexProjection>> {
  const vault = input.vault;
  let currentText = input.currentText;
  if (currentText === undefined) {
    try {
      currentText = await readFile(join(vault, "index.md"), "utf8");
    } catch {
      currentText = "";
    }
  }

  const unmanaged = extractUnmanaged(currentText);
  if (!unmanaged.ok) return unmanaged;

  const scan = await scanVault(vault);
  if (!scan.ok) return scan;

  const entries: RootIndexEntry[] = [];
  const seen = new Map<string, string>(); // target -> title
  let duplicatesRemoved = 0;

  for (const page of scan.data.typedKnowledge) {
    let text: string;
    try {
      text = await readFile(join(vault, page.relPath), "utf8");
    } catch {
      continue;
    }
    const prepared = prepareTypedPage(text, page.relPath);
    if (!prepared.ok) continue;
    const section = TYPE_SECTION[prepared.data.type];
    if (!section) continue;
    const target = prepared.data.target.replace(/\.md$/, "");
    const prev = seen.get(target);
    if (prev !== undefined) {
      if (prev !== prepared.data.title) {
        return err("SCHEME_REJECTED", {
          message: `duplicate index target ${target} with differing titles`,
          titles: [prev, prepared.data.title],
        });
      }
      duplicatesRemoved += 1;
      continue;
    }
    seen.set(target, prepared.data.title);
    entries.push({
      section,
      target,
      title: prepared.data.title,
      source: "typed",
    });
  }

  // Immediate projects/<slug>/README.md only
  try {
    const projectsRoot = join(vault, "projects");
    for (const slug of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const readmePath = join(projectsRoot, slug.name, "README.md");
      let text: string;
      try {
        text = readFileSync(readmePath, "utf8");
      } catch {
        continue;
      }
      const target = `projects/${slug.name}/README`;
      const title = projectTitleFromReadme(text, slug.name);
      const prev = seen.get(target);
      if (prev !== undefined) {
        if (prev !== title) {
          return err("SCHEME_REJECTED", {
            message: `duplicate index target ${target} with differing titles`,
          });
        }
        duplicatesRemoved += 1;
        continue;
      }
      seen.set(target, title);
      entries.push({ section: "Projects", target, title, source: "project" });
    }
  } catch {
    /* no projects dir */
  }

  entries.sort((a, b) => {
    const sa = SECTION_ORDER.indexOf(a.section);
    const sb = SECTION_ORDER.indexOf(b.section);
    if (sa !== sb) return sa - sb;
    return compareText(a.target, b.target);
  });

  const prior = priorWikilinkTargets(currentText);
  const generatedTargets = new Set(entries.map((e) => e.target));
  // Count prior generated-section duplicates (case-folded target collisions in prior index)
  const priorLower = new Map<string, number>();
  for (const t of prior) {
    const k = t.toLowerCase();
    priorLower.set(k, (priorLower.get(k) ?? 0) + 1);
  }
  for (const count of priorLower.values()) {
    if (count > 1) duplicatesRemoved += count - 1;
  }
  // Also count prior section heading case-duplicates as diagnostic when both
  // "entities" and "Entities" style appear as separate ## headings for same type.
  const headingDupes = (currentText.match(/^##\s+(entities|concepts|comparisons|queries|meta|projects)\s*$/gim) ?? [])
    .map((h) => h.replace(/^##\s+/i, "").trim().toLowerCase());
  const headingCounts = new Map<string, number>();
  for (const h of headingDupes) headingCounts.set(h, (headingCounts.get(h) ?? 0) + 1);
  for (const c of headingCounts.values()) {
    if (c > 1) duplicatesRemoved += c - 1;
  }

  const ghostsRemoved = [
    ...new Set(
      prior.filter((t) => {
        const bare = t.includes("/") ? t : null;
        if (bare && !generatedTargets.has(bare) && !generatedTargets.has(t)) {
          // path-style prior link that is not regenerated
          if (!seen.has(t)) return true;
        }
        // basename-style ghosts
        if (!t.includes("/")) {
          const matches = [...generatedTargets].filter((g) => g.split("/").pop() === t);
          return matches.length === 0;
        }
        return !generatedTargets.has(t);
      }),
    ),
  ];

  const lines: string[] = [
    "# Vault Index",
    "",
    "Generated by `skillwiki index rebuild`. Generated sections are derived from typed-page frontmatter and project manifests.",
    "",
  ];

  for (const section of SECTION_ORDER) {
    lines.push(`## ${section}`, "");
    const sectionEntries = entries.filter((e) => e.section === section);
    for (const e of sectionEntries) {
      lines.push(`- [[${e.target}]] — ${e.title}`);
    }
    if (sectionEntries.length > 0) lines.push("");
  }

  lines.push(UNMANAGED_START);
  if (unmanaged.data) {
    lines.push(unmanaged.data);
  }
  lines.push(UNMANAGED_END);
  lines.push("");

  return ok({
    text: lines.join("\n"),
    entries,
    duplicates_removed: duplicatesRemoved,
    ghosts_removed: ghostsRemoved,
  });
}

export async function writeRootIndexProjection(
  vault: string,
  projection: RootIndexProjection,
): Promise<Result<{ changed: boolean }>> {
  return atomicWriteText(join(vault, "index.md"), projection.text);
}
