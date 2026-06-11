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
      relevance: 35,
      actionability: 25,
      authorityActivity: 20,
      freshness: 10,
      novelty: 10,
    });
    expect(score.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("relevance"),
        expect.stringContaining("implementation signals"),
        expect.stringContaining("authority/activity"),
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
    expect(score.components.novelty).toBe(0);
    expect(score.components.freshness).toBe(0);
    expect(score.reasons.join("\n")).toContain("already known");
    expect(score.reasons.join("\n")).toContain("stale");
  });
});
