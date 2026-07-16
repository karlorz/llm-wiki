import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "@skillwiki/shared";
import { prepareTypedPage } from "./typed-page.js";
import { scanVault, type VaultScan } from "./vault.js";

export const ROOT_INDEX_SECTION_ORDER = [
  "Entities",
  "Concepts",
  "Comparisons",
  "Queries",
  "Meta",
  "Projects",
] as const;

export interface RootIndexEntry {
  section: (typeof ROOT_INDEX_SECTION_ORDER)[number];
  target: string;
  title: string;
  source: "typed" | "project";
}

export interface RejectedRootIndexTypedPage {
  relPath: string;
  error: string;
  detail?: unknown;
}

export interface RootIndexUniverse {
  required: RootIndexEntry[];
  knownTargets: ReadonlySet<string>;
  rejectedTyped: RejectedRootIndexTypedPage[];
  duplicatesRemoved: number;
}

export interface BuildRootIndexUniverseInput {
  vault: string;
  scan?: VaultScan;
}

const TYPE_SECTION: Record<string, RootIndexEntry["section"]> = {
  entity: "Entities",
  concept: "Concepts",
  comparison: "Comparisons",
  query: "Queries",
  meta: "Meta",
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function projectTitleFromReadme(text: string, slug: string): string {
  const match = text.match(/^#\s+Project:\s+(.+)$/m);
  return match?.[1]?.trim() || slug;
}

export async function buildRootIndexUniverse(
  input: BuildRootIndexUniverseInput,
): Promise<Result<RootIndexUniverse>> {
  const scanned = input.scan ? ok(input.scan) : await scanVault(input.vault);
  if (!scanned.ok) return scanned;

  const required: RootIndexEntry[] = [];
  const rejectedTyped: RejectedRootIndexTypedPage[] = [];
  const seen = new Map<string, string>();
  let duplicatesRemoved = 0;

  const typedPages = [...scanned.data.typedKnowledge]
    .sort((a, b) => compareText(a.relPath, b.relPath));
  for (const page of typedPages) {
    let text: string;
    try {
      text = await readFile(page.absPath, "utf8");
    } catch {
      continue;
    }

    const prepared = prepareTypedPage(text, page.relPath);
    if (!prepared.ok) {
      rejectedTyped.push({
        relPath: page.relPath,
        error: prepared.error,
        detail: prepared.detail,
      });
      continue;
    }

    const section = TYPE_SECTION[prepared.data.type];
    if (!section) {
      rejectedTyped.push({
        relPath: page.relPath,
        error: "SCHEME_REJECTED",
        detail: { type: prepared.data.type },
      });
      continue;
    }

    const target = prepared.data.target.replace(/\.md$/, "");
    const previousTitle = seen.get(target);
    if (previousTitle !== undefined) {
      if (previousTitle !== prepared.data.title) {
        return err("SCHEME_REJECTED", {
          message: `duplicate index target ${target} with differing titles`,
          titles: [previousTitle, prepared.data.title],
        });
      }
      duplicatesRemoved += 1;
      continue;
    }

    seen.set(target, prepared.data.title);
    required.push({
      section,
      target,
      title: prepared.data.title,
      source: "typed",
    });
  }

  const projectReadmes = scanned.data.allMarkdown
    .filter((page) => /^projects\/[^/]+\/README\.md$/.test(page.relPath))
    .sort((a, b) => compareText(a.relPath, b.relPath));
  for (const readme of projectReadmes) {
    let text: string;
    try {
      text = await readFile(readme.absPath, "utf8");
    } catch {
      continue;
    }
    const projectSlug = readme.relPath.split("/")[1]!;
    const target = `projects/${projectSlug}/README`;
    const title = projectTitleFromReadme(text, projectSlug);
    const previousTitle = seen.get(target);
    if (previousTitle !== undefined) {
      if (previousTitle !== title) {
        return err("SCHEME_REJECTED", {
          message: `duplicate index target ${target} with differing titles`,
        });
      }
      duplicatesRemoved += 1;
      continue;
    }
    seen.set(target, title);
    required.push({ section: "Projects", target, title, source: "project" });
  }

  required.sort((a, b) => {
    const sectionA = ROOT_INDEX_SECTION_ORDER.indexOf(a.section);
    const sectionB = ROOT_INDEX_SECTION_ORDER.indexOf(b.section);
    if (sectionA !== sectionB) return sectionA - sectionB;
    return compareText(a.target, b.target);
  });

  const knownTargets = new Set(required.map((entry) => entry.target));
  for (const page of [...scanned.data.compound].sort((a, b) => compareText(a.relPath, b.relPath))) {
    knownTargets.add(page.relPath.replace(/\.md$/, ""));
  }

  return ok({
    required,
    knownTargets,
    rejectedTyped,
    duplicatesRemoved,
  });
}
