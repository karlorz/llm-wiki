import type { VaultPage } from "./vault.js";

/**
 * Deterministic vault wikilink resolver shared by link lint, graph building,
 * and frontmatter checks. Exact vault-relative paths win; basename fallback is
 * only accepted when it is unambiguous.
 */
export interface WikilinkResolution {
  target: string;
  path?: string;
  ambiguous: boolean;
  reason?: "missing" | "ambiguous" | "unsupported";
}

export interface WikilinkResolver {
  resolve(target: string): WikilinkResolution;
}

const EXCLUDED_PREFIXES = [
  ".git/",
  ".skillwiki/",
  "_archive/",
  "drafts/",
  "tmp/",
];
const RESOLVABLE_PROJECT_ARTIFACT_RE =
  /^projects\/[^/]+\/(?:knowledge\.md|README\.md|(?:compound|requirements|architecture|history|work)\/(?:[^/]+\/)*[^/]+\.md)$/i;

function normalizeTarget(target: string): string {
  return target
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

/**
 * Project artifacts are first-class links only inside the declared workspace
 * surfaces. Raw transcripts and infrastructure caches remain citations or
 * implementation details rather than graph nodes.
 */
export function isResolvableProjectArtifact(relPath: string): boolean {
  return RESOLVABLE_PROJECT_ARTIFACT_RE.test(relPath);
}

function isResolvablePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return !normalized.startsWith("projects/") || isResolvableProjectArtifact(normalized);
}

export function buildWikilinkResolver(pages: VaultPage[]): WikilinkResolver {
  const exact = new Map<string, string>();
  const byBasename = new Map<string, string[]>();

  for (const page of pages) {
    if (!isResolvablePath(page.relPath)) continue;
    const normalizedPath = normalizeTarget(page.relPath);
    exact.set(normalizedPath, page.relPath);
    const basename = normalizedPath.split("/").pop()!;
    const candidates = byBasename.get(basename) ?? [];
    candidates.push(page.relPath);
    byBasename.set(basename, candidates);
  }

  for (const candidates of byBasename.values()) candidates.sort();

  return {
    resolve(target: string): WikilinkResolution {
      const normalized = normalizeTarget(target);
      const exactPath = exact.get(normalized);
      if (exactPath) return { target, path: exactPath, ambiguous: false };

      // A project-qualified target must be exact. Falling back to a basename
      // here could silently resolve a link to a different project's artifact.
      if (normalized.startsWith("projects/")) {
        return {
          target,
          ambiguous: false,
          reason: isResolvablePath(`${normalized}.md`) ? "missing" : "unsupported",
        };
      }

      const candidates = byBasename.get(normalized) ?? [];
      if (candidates.length === 1) {
        return { target, path: candidates[0], ambiguous: false };
      }
      if (candidates.length > 1) {
        return { target, ambiguous: true, reason: "ambiguous" };
      }
      return { target, ambiguous: false, reason: "missing" };
    },
  };
}
