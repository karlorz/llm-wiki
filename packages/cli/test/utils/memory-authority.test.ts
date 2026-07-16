import { describe, expect, it } from "vitest";
import {
  classifyMemoryAuthority,
  compareMemoryAuthority,
  memoryAuthorityTiersRank,
} from "../../src/utils/memory-authority.js";

describe("classifyMemoryAuthority", () => {
  it("classifies accepted operational decisions", () => {
    expect(
      classifyMemoryAuthority({
        memory_kind: "decision-context",
        memory_policy: "operational",
        memory_status: "active",
      }),
    ).toBe("accepted-decision");
  });

  it("classifies other active operational guidance", () => {
    expect(
      classifyMemoryAuthority({
        memory_kind: "workflow-pattern",
        memory_policy: "operational",
        memory_status: "active",
      }),
    ).toBe("operational-guidance");
  });

  it("classifies proposed/draft/pending and research policies", () => {
    expect(
      classifyMemoryAuthority({
        memory_kind: "decision-context",
        memory_policy: "operational",
        memory_status: "proposed",
      }),
    ).toBe("proposed");
    expect(
      classifyMemoryAuthority({
        memory_policy: "research",
        memory_status: "active",
      }),
    ).toBe("proposed");
  });

  it("classifies exploratory patterns", () => {
    expect(
      classifyMemoryAuthority({
        memory_kind: "workflow-pattern",
        memory_policy: "exploratory",
        memory_status: "active",
      }),
    ).toBe("exploratory");
  });

  it("falls back to unclassified for metadata-poor sources", () => {
    expect(classifyMemoryAuthority({ path: "concepts/legacy.md", updated: "2026-01-01" })).toBe(
      "unclassified",
    );
  });
});

describe("compareMemoryAuthority", () => {
  const acceptedOld = {
    path: "projects/llm-wiki/architecture/accepted.md",
    updated: "2026-06-19",
    memory_kind: "decision-context",
    memory_policy: "operational",
    memory_status: "active",
    project: "llm-wiki",
  };
  const proposedNew = {
    path: "projects/llm-wiki/architecture/proposed.md",
    updated: "2026-07-15",
    memory_kind: "decision-context",
    memory_policy: "operational",
    memory_status: "proposed",
    project: "llm-wiki",
  };
  const exploratoryNew = {
    path: "concepts/exploratory.md",
    updated: "2026-07-16",
    memory_kind: "workflow-pattern",
    memory_policy: "exploratory",
    memory_status: "active",
  };

  it("ranks older accepted decisions ahead of newer proposed and exploratory sources", () => {
    const ordered = [exploratoryNew, proposedNew, acceptedOld].sort((a, b) =>
      compareMemoryAuthority(a, b),
    );
    expect(ordered.map((s) => s.path)).toEqual([
      "projects/llm-wiki/architecture/accepted.md",
      "projects/llm-wiki/architecture/proposed.md",
      "concepts/exploratory.md",
    ]);
  });

  it("uses recency only within the same authority tier", () => {
    const olderOps = {
      path: "concepts/ops-old.md",
      updated: "2026-06-01",
      memory_policy: "operational",
      memory_status: "active",
    };
    const newerOps = {
      path: "concepts/ops-new.md",
      updated: "2026-07-01",
      memory_policy: "operational",
      memory_status: "active",
    };
    const ordered = [olderOps, newerOps].sort((a, b) => compareMemoryAuthority(a, b));
    expect(ordered.map((s) => s.path)).toEqual(["concepts/ops-new.md", "concepts/ops-old.md"]);
  });

  it("prefers project-local sources only within the same tier when requested", () => {
    const globalAccepted = {
      path: "architecture/global-decision.md",
      updated: "2026-07-16",
      memory_kind: "decision-context",
      memory_policy: "operational",
      memory_status: "active",
    };
    const projectProposed = {
      path: "projects/llm-wiki/architecture/local-proposed.md",
      updated: "2026-07-16",
      memory_kind: "decision-context",
      memory_policy: "operational",
      memory_status: "proposed",
      project: "llm-wiki",
    };
    expect(
      compareMemoryAuthority(globalAccepted, projectProposed, {
        project: "llm-wiki",
        preferProjectWithinTiers: true,
      }),
    ).toBeLessThan(0);

    const projectOps = {
      path: "projects/llm-wiki/architecture/local-ops.md",
      updated: "2026-07-16",
      memory_policy: "operational",
      memory_status: "active",
      memory_scope: "project",
      project: "llm-wiki",
    };
    const globalOps = {
      path: "concepts/global-ops.md",
      updated: "2026-07-16",
      memory_policy: "operational",
      memory_status: "active",
      memory_scope: "global",
    };
    expect(
      compareMemoryAuthority(projectOps, globalOps, {
        project: "llm-wiki",
        preferProjectWithinTiers: true,
      }),
    ).toBeLessThan(0);
    const ordered = [globalOps, projectOps].sort((a, b) =>
      compareMemoryAuthority(a, b, { project: "llm-wiki", preferProjectWithinTiers: true }),
    );
    expect(ordered.map((s) => s.path)).toEqual([
      "projects/llm-wiki/architecture/local-ops.md",
      "concepts/global-ops.md",
    ]);
  });

  it("maps unknown tiers to unclassified rank", () => {
    expect(memoryAuthorityTiersRank(undefined)).toBe(memoryAuthorityTiersRank("unclassified"));
    expect(memoryAuthorityTiersRank("not-a-tier")).toBe(memoryAuthorityTiersRank("unclassified"));
  });
});
