import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { buildWikilinkAdjacency, findSparseCommunities, type SparseCommunity } from "../utils/community.js";

export interface SparseCommunityInput { vault: string; minSize?: number; maxCohesion?: number }
export interface SparseCommunityOutput { communities: SparseCommunity[]; humanHint: string }

/**
 * Lint-internal check (consumed by runLint, NOT registered in cli.ts — mirrors
 * path-too-long / raw-body-dedup). Detects loosely-connected page clusters via
 * Louvain community detection + cohesion, surfaced as the `sparse_community`
 * info bucket.
 */
export async function runSparseCommunity(
  input: SparseCommunityInput,
): Promise<{ exitCode: number; result: Result<SparseCommunityOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const adjacency = await buildWikilinkAdjacency(scan.data.typedKnowledge);
  const communities = findSparseCommunities(adjacency, {
    minSize: input.minSize,
    maxCohesion: input.maxCohesion,
  });

  const humanHint = communities.length === 0
    ? "no sparse communities"
    : communities.map(c => `  cohesion ${c.cohesion} (${c.size} pages): ${c.action}`).join("\n");

  return { exitCode: ExitCode.OK, result: ok({ communities, humanHint }) };
}
