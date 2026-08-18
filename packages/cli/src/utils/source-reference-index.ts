import { extractCitationMarkers } from "../parsers/citations.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { normalizeRawSourceTarget } from "./raw-source.js";
import { readPage, type VaultPage } from "./vault.js";

export interface SourceReferenceIndex {
  integratedBy: Map<string, string[]>;
  referencedElsewhereBy: Map<string, string[]>;
  unresolved: Array<{ sourcePath: string; target: string; kind: "typed" | "other" }>;
}

function canonicalTarget(value: string): string | null {
  const normalized = normalizeRawSourceTarget(value);
  if (!normalized) return null;
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

export function referencesFromText(text: string): string[] {
  const references = new Set<string>();
  const fm = extractFrontmatter(text);
  if (fm.ok && Array.isArray(fm.data.sources)) {
    for (const entry of fm.data.sources) {
      const target = canonicalTarget(String(entry));
      if (target) references.add(target);
    }
  }
  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;
  for (const marker of extractCitationMarkers(body)) {
    const target = canonicalTarget(marker.target);
    if (target) references.add(target);
  }
  return [...references];
}

async function addPages(
  pages: readonly VaultPage[],
  kind: "typed" | "other",
  available: Set<string>,
  targetMap: Map<string, Set<string>>,
  unresolved: SourceReferenceIndex["unresolved"],
  relocationProjection?: ReadonlyMap<string, string>,
): Promise<void> {
  for (const page of pages) {
    let text: string;
    try {
      text = await readPage(page);
    } catch {
      continue;
    }
    for (const historicalTarget of referencesFromText(text)) {
      const target = available.has(historicalTarget)
        ? historicalTarget
        : relocationProjection?.get(historicalTarget) ?? historicalTarget;
      if (!available.has(target)) unresolved.push({ sourcePath: page.relPath, target, kind });
      const refs = targetMap.get(target) ?? new Set<string>();
      refs.add(page.relPath);
      targetMap.set(target, refs);
    }
  }
}

function freezeMap(input: Map<string, Set<string>>): Map<string, string[]> {
  return new Map(
    [...input.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([target, refs]) => [target, [...refs].sort((a, b) => a.localeCompare(b))]),
  );
}

export async function buildSourceReferenceIndex(input: {
  typedPages: readonly VaultPage[];
  otherPages?: readonly VaultPage[];
  availableRawPaths: Iterable<string>;
  relocationProjection?: ReadonlyMap<string, string>;
}): Promise<SourceReferenceIndex> {
  const available = new Set(
    [...input.availableRawPaths]
      .map(canonicalTarget)
      .filter((value): value is string => value !== null),
  );
  const integrated = new Map<string, Set<string>>();
  const elsewhere = new Map<string, Set<string>>();
  const unresolved: SourceReferenceIndex["unresolved"] = [];

  await addPages(input.typedPages, "typed", available, integrated, unresolved, input.relocationProjection);
  await addPages(input.otherPages ?? [], "other", available, elsewhere, unresolved, input.relocationProjection);

  unresolved.sort((a, b) => a.target.localeCompare(b.target) || a.sourcePath.localeCompare(b.sourcePath));
  return {
    integratedBy: freezeMap(integrated),
    referencedElsewhereBy: freezeMap(elsewhere),
    unresolved,
  };
}

export function normalizeSourceReference(value: string): string | null {
  return canonicalTarget(value);
}
