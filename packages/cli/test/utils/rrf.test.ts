import { describe, expect, it } from "vitest";
import { RRF_K, fuseRankings } from "../../src/utils/rrf.js";

describe("RRF", () => {
  it("uses k=60 and prefers items high in both lists", () => {
    expect(RRF_K).toBe(60);
    const fused = fuseRankings([
      ["a", "b", "c"],
      ["c", "a", "d"],
    ]);
    expect(fused[0]?.id).toBe("a");
    expect(fused.find((row) => row.id === "a")!.score).toBeCloseTo(1 / 61 + 1 / 62, 8);
    expect(fused.find((row) => row.id === "d")!.score).toBeCloseTo(1 / 63, 8);
  });

  it("treats missing retrievers as absent ranks", () => {
    const fused = fuseRankings([["only"]]);
    expect(fused).toEqual([{ id: "only", score: 1 / 61 }]);
  });
});
