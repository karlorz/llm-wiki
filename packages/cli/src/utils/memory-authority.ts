/**
 * Deterministic authority ranking for derived agent-memory sources.
 * Pure: no I/O, LLM, embeddings, or network.
 */

export const MEMORY_AUTHORITY_TIERS = [
  "accepted-decision",
  "operational-guidance",
  "proposed",
  "exploratory",
  "unclassified",
] as const;

export type MemoryAuthorityTier = (typeof MEMORY_AUTHORITY_TIERS)[number];

export interface MemoryAuthoritySource {
  path: string;
  updated: string;
  project?: string;
  memory_kind?: string;
  memory_policy?: string;
  memory_status?: string;
  memory_scope?: string;
}

export interface CompareMemoryAuthorityOptions {
  /** Active project slug for same-tier project preference. */
  project?: string;
  /** When true, project-local sources rank ahead within the same authority tier. */
  preferProjectWithinTiers?: boolean;
}

const TIER_RANK: Record<MemoryAuthorityTier, number> = {
  "accepted-decision": 0,
  "operational-guidance": 1,
  proposed: 2,
  exploratory: 3,
  unclassified: 4,
};

export function memoryAuthorityTiersRank(
  tier: MemoryAuthorityTier | string | undefined,
): number {
  if (!tier) return TIER_RANK.unclassified;
  const key = String(tier).toLowerCase() as MemoryAuthorityTier;
  return TIER_RANK[key] ?? TIER_RANK.unclassified;
}

export function classifyMemoryAuthority(
  source: Partial<MemoryAuthoritySource>,
): MemoryAuthorityTier {
  const kind = (source.memory_kind ?? "").toLowerCase();
  const policy = (source.memory_policy ?? "").toLowerCase();
  const status = (source.memory_status ?? "").toLowerCase();

  if (kind === "decision-context" && policy === "operational" && status === "active") {
    return "accepted-decision";
  }
  if (policy === "operational" && status === "active") {
    return "operational-guidance";
  }
  if (
    ["proposed", "draft", "pending"].includes(status) ||
    ["proposed", "hypothesis", "research"].includes(policy)
  ) {
    return "proposed";
  }
  if (policy === "exploratory") {
    return "exploratory";
  }
  return "unclassified";
}

/**
 * Project relevance for same-tier ranking under `--scope all`.
 * Matches memory recall's project-local definition: scope project (or default)
 * bound to the active project, or a path under projects/{project}/.
 */
function isProjectLocal(source: Partial<MemoryAuthoritySource>, project?: string): boolean {
  if (!project) return false;
  if (typeof source.path === "string" && source.path.startsWith(`projects/${project}/`)) {
    return true;
  }
  const scope = (source.memory_scope || "project").toLowerCase();
  if (scope !== "project") return false;
  return !source.project || source.project === project;
}

/**
 * Comparator for Array#sort: negative if `a` should rank before `b`.
 * Order: authority tier → optional same-tier project relevance → updated desc → path asc.
 */
export function compareMemoryAuthority(
  a: Partial<MemoryAuthoritySource> & { path: string; updated: string },
  b: Partial<MemoryAuthoritySource> & { path: string; updated: string },
  options: CompareMemoryAuthorityOptions = {},
): number {
  const tierDiff =
    memoryAuthorityTiersRank(classifyMemoryAuthority(a)) -
    memoryAuthorityTiersRank(classifyMemoryAuthority(b));
  if (tierDiff !== 0) return tierDiff;

  if (options.preferProjectWithinTiers && options.project) {
    const aLocal = Number(isProjectLocal(a, options.project));
    const bLocal = Number(isProjectLocal(b, options.project));
    if (aLocal !== bLocal) return bLocal - aLocal;
  }

  const updatedDiff = b.updated.localeCompare(a.updated);
  if (updatedDiff !== 0) return updatedDiff;

  return a.path.localeCompare(b.path);
}
