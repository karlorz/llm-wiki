export const RRF_K = 60;

export interface FusedRank {
  id: string;
  score: number;
}

/** Reciprocal Rank Fusion over ordered id lists. Rank is 1-based. */
export function fuseRankings(lists: readonly (readonly string[])[], k = RRF_K): FusedRank[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
