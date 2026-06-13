import { describe, expect, it } from "vitest";
import { scoreCandidate } from "../src/score.js";

describe("agent-memory-trends deterministic scoring", () => {
  it("scores high-signal agent memory repositories with transparent 100-point components", () => {
    const score = scoreCandidate(
      {
        name: "local-agent-memory",
        fullName: "acme/local-agent-memory",
        canonicalUrl: "https://github.com/acme/local-agent-memory",
        description: "Local-first MCP agent memory for Claude and Codex session continuity.",
        topics: ["agent-memory", "mcp", "obsidian", "sqlite", "markdown"],
        readmeText:
          "Implements Markdown knowledge base export, SQLite-backed local storage, Obsidian sync, and CLI hooks for cross-agent session continuity.",
        laneIds: ["weekly_momentum", "monthly_authority"],
        qualityGate: "passed",
        evidenceFamilies: ["coding_agent", "memory_state", "skills_subagents", "knowledge_store"],
        stargazersCount: 900,
        forksCount: 120,
        pushedAt: "2026-06-10T12:00:00Z",
        archived: false,
      },
      {
        now: new Date("2026-06-11T00:10:00+08:00"),
        knownCanonicalUrls: [],
        existingTaskUrls: [],
      }
    );

    expect(score.score).toBe(100);
    expect(score.components).toEqual({
      relevance: 30,
      implementationEvidence: 25,
      authorityMomentum: 25,
      freshness: 10,
      noveltyOrTracking: 10,
    });
    expect(score.trackingStatus).toBe("new");
    expect(score.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lane evidence"),
        expect.stringContaining("relevance"),
        expect.stringContaining("implementation signals"),
        expect.stringContaining("authority/momentum"),
        expect.stringContaining("recent activity"),
        expect.stringContaining("novel source"),
      ])
    );
  });

  it("penalizes stale, low-authority, already-known repositories without exceeding bounds", () => {
    const score = scoreCandidate(
      {
        name: "old-memory-demo",
        fullName: "acme/old-memory-demo",
        canonicalUrl: "https://github.com/acme/old-memory-demo",
        description: "Small memory demo.",
        topics: ["memory"],
        readmeText: "Prototype only.",
        laneIds: ["weekly_momentum"],
        qualityGate: "passed",
        evidenceFamilies: ["memory_state"],
        stargazersCount: 3,
        forksCount: 0,
        pushedAt: "2025-01-01T00:00:00Z",
        archived: false,
      },
      {
        now: new Date("2026-06-11T00:10:00+08:00"),
        knownCanonicalUrls: ["https://github.com/acme/old-memory-demo"],
        existingTaskUrls: [],
      }
    );

    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThan(60);
    expect(score.components.noveltyOrTracking).toBe(6);
    expect(score.components.freshness).toBe(0);
    expect(score.trackingStatus).toBe("tracked_existing");
    expect(score.reasons.join("\n")).toContain("already known");
    expect(score.reasons.join("\n")).toContain("tracked existing");
    expect(score.reasons.join("\n")).toContain("stale");
  });
});
