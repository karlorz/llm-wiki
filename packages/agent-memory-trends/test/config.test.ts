import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseResearchConfig,
  readResearchConfig,
  shouldAutoAppendWatchlist,
} from "../src/config.js";

const LANE_CONFIG = `version: 1
project: llm-wiki
timezone: Asia/Hong_Kong
scoring:
  threshold: 65
  weights:
    relevance: 30
    implementation_evidence: 25
    authority_momentum: 25
    freshness: 10
    novelty_or_tracking: 10
github:
  api_call_budget: 100
  max_queries: 24
  max_raw_candidates: 50
  max_selected_candidates: 10
  lanes:
    - id: daily_fresh
      label: Daily fresh
      window_days: 1
      date_field: pushed
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 10
        min_forks: 0
        min_evidence_families: 2
        allow_multi_query_exception: true
      queries:
        - id: daily-memory
          label: Daily coding-agent memory
          query: coding agent memory in:name,description,readme
        - id: daily-checkpoints
          label: Daily coding-agent checkpoints
          query: coding agent checkpoints in:name,description,readme
    - id: weekly_momentum
      label: Weekly momentum
      window_days: 7
      date_field: pushed
      sort: stars
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 50
        min_forks: 5
        min_evidence_families: 2
      queries:
        - id: weekly-checkpoints
          label: Weekly checkpoint memory
          query: checkpoint memory coding agent in:name,description,readme
        - id: weekly-skills
          label: Weekly skills and subagents
          query: agent skills subagents workflow in:name,description,readme
    - id: monthly_authority
      label: Monthly authority
      window_days: 30
      date_field: pushed
      sort: stars
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 100
        min_forks: 10
        min_evidence_families: 2
      queries:
        - id: monthly-workflow
          label: Monthly workflow distillation
          query: workflow distillation agent memory in:name,description,readme
        - id: monthly-context-engineering
          label: Monthly context engineering
          query: context engineering coding agent memory in:name,description,readme
    - id: emerging
      label: Emerging evidence
      window_days: 30
      date_field: created
      sort: updated
      order: desc
      per_page: 10
      quality_gate:
        min_stars: 0
        min_forks: 0
        min_evidence_families: 3
        allow_strong_evidence_exception: true
      queries:
        - id: emerging-goal-judge
          label: Emerging goal judge loops
          query: goal judge loop coding agent in:name,description,readme
        - id: emerging-local-search
          label: Emerging local search memory
          query: local search database agent trajectory memory in:name,description,readme
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

const LEGACY_CONFIG = `version: 1
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
  rejected: []
  archived: []
`;

describe("agent-memory-trends research config", () => {
  it("loads lane-based GitHub discovery config and updated scoring weights", () => {
    const parsed = parseResearchConfig(LANE_CONFIG, "test-config.yaml");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected config to parse");
    expect(parsed.data.project).toBe("llm-wiki");
    expect(parsed.data.github.lanes.map((lane) => lane.id)).toEqual([
      "daily_fresh",
      "weekly_momentum",
      "monthly_authority",
      "emerging",
    ]);
    expect(parsed.data.github.lanes[0]).toMatchObject({
      id: "daily_fresh",
      windowDays: 1,
      dateField: "pushed",
      sort: "updated",
      order: "desc",
      perPage: 10,
      qualityGate: {
        minStars: 10,
        minForks: 0,
        minEvidenceFamilies: 2,
        allowMultiQueryException: true,
      },
    });
    expect(parsed.data.github.lanes[2].queries.map((query) => query.id)).toEqual([
      "monthly-workflow",
      "monthly-context-engineering",
    ]);
    expect(parsed.data.github.maxQueries).toBe(24);
    expect(parsed.data.github.maxRawCandidates).toBe(50);
    expect(parsed.data.github.maxSelectedCandidates).toBe(10);
    expect(parsed.data.github.apiCallBudget).toBe(100);
    expect(parsed.data.dedupe.digestTtlDays).toBe(14);
    expect(parsed.data.scoring.weights).toEqual({
      relevance: 30,
      implementationEvidence: 25,
      authorityMomentum: 25,
      freshness: 10,
      noveltyOrTracking: 10,
    });
  });

  it("bridges the legacy flat ten-query portfolio into one explicit compatibility lane", () => {
    const parsed = parseResearchConfig(LEGACY_CONFIG, "legacy-config.yaml");

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected legacy config to parse");
    expect(parsed.data.github.lanes).toHaveLength(1);
    expect(parsed.data.github.lanes[0]).toMatchObject({
      id: "legacy_flat",
      label: "Legacy flat query portfolio",
      windowDays: 0,
      dateField: "pushed",
      sort: "updated",
      order: "desc",
      perPage: 10,
      qualityGate: {
        minStars: 0,
        minForks: 0,
        minEvidenceFamilies: 0,
      },
    });
    expect(parsed.data.github.lanes[0].queries.map((query) => query.id)).toEqual([
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
  });

  it("rejects configs that exceed the agreed GitHub collection caps", () => {
    const parsed = parseResearchConfig(
      LANE_CONFIG.replace("max_queries: 24", "max_queries: 25"),
      "too-many-queries.yaml"
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected invalid config");
    expect(parsed.error).toBe("CONFIG_INVALID");
    expect(String(parsed.detail)).toContain("max_queries");
  });

  it("rejects invalid lane fields with a clear migration error", () => {
    const parsed = parseResearchConfig(
      LANE_CONFIG.replace("sort: updated", "sort: recency"),
      "bad-lane.yaml"
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected invalid config");
    expect(parsed.error).toBe("CONFIG_INVALID");
    expect(String(parsed.detail)).toContain("github.lanes[0].sort");
  });

  it("accepts an explicit digest duplicate TTL and rejects negative values", () => {
    const explicit = parseResearchConfig(
      LANE_CONFIG.replace("watchlist:\n", "dedupe:\n  digest_ttl_days: 21\nwatchlist:\n"),
      "explicit-dedupe.yaml"
    );

    expect(explicit.ok).toBe(true);
    if (!explicit.ok) throw new Error("expected explicit dedupe config to parse");
    expect(explicit.data.dedupe.digestTtlDays).toBe(21);

    const negative = parseResearchConfig(
      LANE_CONFIG.replace("watchlist:\n", "dedupe:\n  digest_ttl_days: -1\nwatchlist:\n"),
      "negative-dedupe.yaml"
    );

    expect(negative.ok).toBe(false);
    if (negative.ok) throw new Error("expected invalid config");
    expect(negative.error).toBe("CONFIG_INVALID");
    expect(String(negative.detail)).toContain("dedupe.digest_ttl_days");
  });

  it("reads YAML from disk with the same validation", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-memory-trends-config-"));
    const configPath = join(dir, "agent-memory-research-sources.yaml");
    writeFileSync(configPath, LANE_CONFIG, "utf8");

    const parsed = readResearchConfig(configPath);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected disk config to parse");
    expect(parsed.data.sourcePath).toBe(configPath);
  });

  it("auto-appends only stable, repeated, above-threshold repository signals", () => {
    const parsed = parseResearchConfig(LANE_CONFIG, "test-config.yaml");
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
    const parsed = parseResearchConfig(LANE_CONFIG, "test-config.yaml");
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
