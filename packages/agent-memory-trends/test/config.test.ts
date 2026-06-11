import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseResearchConfig,
  readResearchConfig,
  shouldAutoAppendWatchlist,
} from "../src/config.js";

const VALID_CONFIG = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 35
    actionability: 25
    authority_activity: 20
    freshness: 10
    novelty: 10
github:
  api_call_budget: 100
  max_queries: 10
  max_raw_candidates: 50
  max_selected_candidates: 10
  queries:
    - id: claude-agent-memory
      label: Claude agent memory
      query: claude agent memory in:name,description,readme
    - id: codex-agent-memory
      label: Codex agent memory
      query: codex agent memory in:name,description,readme
    - id: cross-agent-memory
      label: cross-agent memory
      query: cross agent memory in:name,description,readme
    - id: session-continuity-agent
      label: session continuity agent
      query: session continuity agent in:name,description,readme
    - id: mcp-memory
      label: MCP memory
      query: MCP memory agent in:name,description,readme
    - id: obsidian-agent-memory
      label: Obsidian agent memory
      query: obsidian agent memory in:name,description,readme
    - id: markdown-knowledge-base-agent
      label: Markdown knowledge base agent
      query: markdown knowledge base agent in:name,description,readme
    - id: sqlite-agent-memory
      label: SQLite agent memory
      query: sqlite agent memory in:name,description,readme
    - id: second-brain-agent-memory
      label: second brain agent memory
      query: second brain agent memory in:name,description,readme
    - id: local-first-memory-sync
      label: local-first memory sync
      query: local first memory sync in:name,description,readme
watchlist:
  auto_append:
    min_appearances: 3
    window_days: 14
    min_score: 65
  accepted: []
  rejected:
    - canonical_url: https://github.com/nope/rejected
      reason: not relevant to llm-wiki
  archived:
    - canonical_url: https://github.com/old/archived
      reason: superseded
`;

describe("agent-memory-trends research config", () => {
  it("loads the accepted ten-query portfolio and hard collection budgets", () => {
    const parsed = parseResearchConfig(VALID_CONFIG, "test-config.yaml");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected config to parse");
    expect(parsed.data.project).toBe("llm-wiki");
    expect(parsed.data.github.queries.map((query) => query.id)).toEqual([
      "claude-agent-memory",
      "codex-agent-memory",
      "cross-agent-memory",
      "session-continuity-agent",
      "mcp-memory",
      "obsidian-agent-memory",
      "markdown-knowledge-base-agent",
      "sqlite-agent-memory",
      "second-brain-agent-memory",
      "local-first-memory-sync",
    ]);
    expect(parsed.data.github.maxQueries).toBe(10);
    expect(parsed.data.github.maxRawCandidates).toBe(50);
    expect(parsed.data.github.maxSelectedCandidates).toBe(10);
    expect(parsed.data.github.apiCallBudget).toBe(100);
    expect(parsed.data.scoring.weights).toEqual({
      relevance: 35,
      actionability: 25,
      authorityActivity: 20,
      freshness: 10,
      novelty: 10,
    });
  });

  it("rejects configs that exceed the agreed GitHub collection caps", () => {
    const parsed = parseResearchConfig(
      VALID_CONFIG.replace("max_queries: 10", "max_queries: 11"),
      "too-many-queries.yaml"
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected invalid config");
    expect(parsed.error).toBe("CONFIG_INVALID");
    expect(String(parsed.detail)).toContain("max_queries");
  });

  it("reads YAML from disk with the same validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-memory-trends-config-"));
    const configPath = join(dir, "agent-memory-research-sources.yaml");
    writeFileSync(configPath, VALID_CONFIG, "utf8");

    const parsed = readResearchConfig(configPath);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected disk config to parse");
    expect(parsed.data.sourcePath).toBe(configPath);
  });

  it("auto-appends only stable, repeated, above-threshold repository signals", () => {
    const parsed = parseResearchConfig(VALID_CONFIG, "test-config.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const decision = shouldAutoAppendWatchlist({
      candidate: {
        canonicalUrl: "https://github.com/acme/local-agent-memory",
        name: "acme/local-agent-memory",
      },
      appearances: [
        { seenAt: "2026-06-01", score: 73, canonicalUrl: "https://github.com/acme/local-agent-memory" },
        { seenAt: "2026-06-06", score: 71, canonicalUrl: "https://github.com/acme/local-agent-memory" },
        { seenAt: "2026-06-10", score: 69, canonicalUrl: "https://github.com/acme/local-agent-memory" },
      ],
      config: parsed.data,
      now: new Date("2026-06-11T00:10:00+08:00"),
    });

    expect(decision.shouldAppend).toBe(true);
    expect(decision.reason).toContain("3 appearances");
    expect(decision.reason).toContain("14 days");
  });

  it("does not auto-append rejected, archived, unstable, or below-threshold signals", () => {
    const parsed = parseResearchConfig(VALID_CONFIG, "test-config.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const rejected = shouldAutoAppendWatchlist({
      candidate: { canonicalUrl: "https://github.com/nope/rejected", name: "nope/rejected" },
      appearances: [
        { seenAt: "2026-06-01", score: 90, canonicalUrl: "https://github.com/nope/rejected" },
        { seenAt: "2026-06-06", score: 90, canonicalUrl: "https://github.com/nope/rejected" },
        { seenAt: "2026-06-10", score: 90, canonicalUrl: "https://github.com/nope/rejected" },
      ],
      config: parsed.data,
      now: new Date("2026-06-11T00:10:00+08:00"),
    });
    expect(rejected.shouldAppend).toBe(false);
    expect(rejected.reason).toContain("rejected");

    const unstable = shouldAutoAppendWatchlist({
      candidate: { canonicalUrl: "https://github.com/acme/local-agent-memory", name: "acme/local-agent-memory" },
      appearances: [
        { seenAt: "2026-06-01", score: 90, canonicalUrl: "https://github.com/acme/local-agent-memory" },
        { seenAt: "2026-06-06", score: 90, canonicalUrl: "https://github.com/acme/local-agent-memory-v2" },
        { seenAt: "2026-06-10", score: 90, canonicalUrl: "https://github.com/acme/local-agent-memory" },
      ],
      config: parsed.data,
      now: new Date("2026-06-11T00:10:00+08:00"),
    });
    expect(unstable.shouldAppend).toBe(false);
    expect(unstable.reason).toContain("stable canonical URL");
  });
});
