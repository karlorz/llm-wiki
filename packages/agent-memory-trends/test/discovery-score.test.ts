import { describe, expect, it } from "vitest";
import type { ResearchConfig } from "../src/config.js";
import {
  DISCOVERY_DISPOSITIONS,
  makeDiscoveryCandidate,
  type DiscoveryCandidate,
  type DiscoveryCandidateFacts,
  type DiscoveryConfig,
} from "../src/discovery-contracts.js";
import { buildDiscoveryQueue, evaluateDiscoveryCandidate } from "../src/discovery-score.js";

const NOW = new Date("2026-08-14T00:00:00Z");

function makeConfig(overrides: Partial<DiscoveryConfig> = {}): ResearchConfig {
  const discovery: DiscoveryConfig = {
    enabled: true,
    maxDailyCandidates: 20,
    retentionDays: 30,
    immediateAlert: { enabled: true, minRepositorySignal: 30, minIndependentSignalCount: 2 },
    github: { apiCallBudget: 60, maxSearchQueries: 24, maxEnrichments: 40, lanes: [] },
    officialOrganizations: [
      { github: "deepseek-ai", region: "CN", officialUrls: ["https://www.deepseek.com/"], categories: ["models"] },
    ],
    communitySources: [
      { id: "hacker_news", enabled: true, role: "corroboration" },
      { id: "hugging_face", enabled: true, role: "corroboration" },
      { id: "chinese_public_sources", enabled: true, role: "discovery" },
    ],
    ...overrides,
  };
  return {
    sourcePath: "test.yaml",
    version: 2,
    project: "llm-wiki",
    timezone: "UTC",
    dedupe: { digestTtlDays: 14 },
    scoring: {
      threshold: 65,
      weights: { relevance: 30, implementationEvidence: 25, authorityMomentum: 25, freshness: 10, noveltyOrTracking: 10 },
    },
    github: { apiCallBudget: 100, maxQueries: 24, maxRawCandidates: 50, maxSelectedCandidates: 10, lanes: [], queries: [] },
    watchlist: { autoAppend: { minAppearances: 3, windowDays: 14, minScore: 65 }, accepted: [], rejected: [], archived: [] },
    discovery,
  };
}

function makeCandidate(overrides: Partial<DiscoveryCandidateFacts> = {}): DiscoveryCandidate {
  return makeDiscoveryCandidate({
    canonicalUrl: "https://github.com/acme/repo-a",
    fullName: "acme/repo-a",
    owner: "acme",
    name: "repo-a",
    createdAt: "2026-06-01T00:00:00Z",
    pushedAt: "2026-08-10T00:00:00Z",
    stargazersCount: 300,
    forksCount: 20,
    archived: false,
    topics: ["agent-memory"],
    description: "coding agent memory",
    license: "MIT",
    defaultBranch: "main",
    sourceIds: ["lane:release_velocity", "query:release-new"],
    attentionEvidence: [],
    relevanceInput: 80,
    evidenceQualityInput: 40,
    ...overrides,
  });
}

function context(config: ResearchConfig, trackedUrls: string[] = []) {
  return { config, now: NOW, trackedUrls };
}

describe("agent-memory-trends discovery ranker", () => {
  it("caps the final queue at maxDailyCandidates and sorts deterministically", () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      makeCandidate({
        canonicalUrl: `https://github.com/acme/repo-${index}`,
        fullName: `acme/repo-${index}`,
        owner: "acme",
        name: `repo-${index}`,
        stargazersCount: 100 + index,
        relevanceInput: 50 + index * 2,
      })
    );
    const queue = buildDiscoveryQueue(candidates, context(makeConfig()));
    expect(queue.candidates).toHaveLength(20);
    expect(queue.counts.queued).toBe(20);
    expect(queue.counts.totalEvaluated).toBe(25);
    const totals = queue.candidates.map((candidate) => candidate.score.total);
    expect([...totals].sort((left, right) => right - left)).toEqual(totals);
    expect(queue.candidates[0]!.canonicalUrl).toBe("https://github.com/acme/repo-24");
  });

  it("keeps tracked candidates with fresh momentum in the queue but flags them ineligible for automatic promotion", () => {
    const trackedUrl = "https://github.com/acme/repo-tracked";
    const tracked = makeCandidate({
      canonicalUrl: trackedUrl,
      fullName: "acme/repo-tracked",
      owner: "acme",
      name: "repo-tracked",
      stargazersCount: 500,
      pushedAt: "2026-08-12T00:00:00Z",
    });
    const queue = buildDiscoveryQueue([tracked], context(makeConfig(), [trackedUrl]));
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]!.disposition).toBe("tracked");
    expect(queue.candidates[0]!.promotionEligible).toBe(false);
    expect(queue.candidates[0]!.alert).toBe(false);
    expect(queue.counts.tracked).toBe(1);

    const accelerated = {
      ...makeCandidate({
        canonicalUrl: trackedUrl,
        fullName: "acme/repo-tracked",
        owner: "acme",
        name: "repo-tracked",
        pushedAt: "2025-01-01T00:00:00Z",
      }),
      starDelta24h: 15,
    };
    const acceleratedQueue = buildDiscoveryQueue([accelerated], context(makeConfig(), [trackedUrl]));
    expect(acceleratedQueue.candidates).toHaveLength(1);
    expect(acceleratedQueue.candidates[0]!.disposition).toBe("tracked");
  });

  it("suppresses tracked candidates without fresh momentum", () => {
    const trackedUrl = "https://github.com/acme/repo-stale";
    const stale = makeCandidate({
      canonicalUrl: trackedUrl,
      fullName: "acme/repo-stale",
      owner: "acme",
      name: "repo-stale",
      pushedAt: "2025-01-01T00:00:00Z",
    });
    const queue = buildDiscoveryQueue([stale], context(makeConfig(), [trackedUrl]));
    expect(queue.candidates).toHaveLength(0);
    expect(queue.counts.suppressed).toBe(1);
    expect(queue.counts.tracked).toBe(0);
  });

  it("requires both a repository-signal threshold and the configured number of independent non-GitHub sources for an alert", () => {
    const hot = makeCandidate({ stargazersCount: 5000, forksCount: 500 });
    const hn = { sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1" };
    const hf = { sourceId: "hugging_face", url: "https://huggingface.co/spaces/acme" };

    const oneSignal = { ...hot, attentionEvidence: [hn] };
    const oneQueue = buildDiscoveryQueue([oneSignal], context(makeConfig()));
    expect(oneQueue.candidates[0]!.disposition).not.toBe("alert");
    expect(oneQueue.candidates[0]!.alert).toBe(false);

    const twoSignals = { ...hot, attentionEvidence: [hn, hf] };
    const twoQueue = buildDiscoveryQueue([twoSignals], context(makeConfig()));
    expect(twoQueue.candidates[0]!.disposition).toBe("alert");
    expect(twoQueue.candidates[0]!.alert).toBe(true);
    expect(twoQueue.candidates[0]!.promotionEligible).toBe(true);
    expect(twoQueue.counts.alert).toBe(1);

    const belowThreshold = {
      ...makeCandidate({ pushedAt: "2025-01-01T00:00:00Z", stargazersCount: 0, forksCount: 0 }),
      attentionEvidence: [hn, hf],
    };
    const belowQueue = buildDiscoveryQueue([belowThreshold], context(makeConfig()));
    expect(belowQueue.candidates[0]!.disposition).not.toBe("alert");
    expect(belowQueue.candidates[0]!.disposition).toBe("watch");

    const seedOnly = makeCandidate({
      owner: "deepseek-ai",
      fullName: "deepseek-ai/chat",
      name: "chat",
      canonicalUrl: "https://github.com/deepseek-ai/chat",
      stargazersCount: 5000,
      forksCount: 500,
      sourceIds: ["github_org_seed:deepseek-ai"],
    });
    const seedQueue = buildDiscoveryQueue([seedOnly], context(makeConfig()));
    expect(seedQueue.candidates[0]!.disposition).not.toBe("alert");
    expect(seedQueue.candidates[0]!.score.repositorySignal).toBeGreaterThanOrEqual(30);
    expect(seedQueue.candidates[0]!.alert).toBe(false);
  });

  it("never emits alert dispositions when immediate alerts are disabled", () => {
    const config = makeConfig({
      immediateAlert: { enabled: false, minRepositorySignal: 30, minIndependentSignalCount: 2 },
    });
    const hot = makeCandidate({ stargazersCount: 5000, forksCount: 500 });
    const withSignals = {
      ...hot,
      attentionEvidence: [
        { sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1" },
        { sourceId: "hugging_face", url: "https://huggingface.co/spaces/acme" },
      ],
    };
    const queue = buildDiscoveryQueue([withSignals], context(config));
    expect(queue.candidates[0]!.disposition).not.toBe("alert");
    expect(queue.candidates[0]!.alert).toBe(false);
    expect(queue.counts.alert).toBe(0);
  });

  it("suppresses archived repositories", () => {
    const archived = makeCandidate({ archived: true, stargazersCount: 5000, forksCount: 500 });
    const queue = buildDiscoveryQueue([archived], context(makeConfig()));
    expect(queue.candidates).toHaveLength(0);
    expect(queue.counts.suppressed).toBe(1);
  });

  it("produces bounded, explainable score components with deterministic reasons", () => {
    const extreme = {
      ...makeCandidate({ stargazersCount: 100000, forksCount: 100000, pushedAt: "2026-08-13T00:00:00Z" }),
      starDelta24h: 999,
    };
    const evaluated = evaluateDiscoveryCandidate(extreme, context(makeConfig()));
    expect(evaluated.score.components.momentum).toBe(40);
    expect(evaluated.score.repositorySignal).toBe(evaluated.score.components.momentum + evaluated.score.components.officialIdentity);
    expect(evaluated.score.repositorySignal).toBeLessThanOrEqual(55);
    expect(evaluated.score.total).toBeLessThanOrEqual(100);
    expect(evaluated.score.components.corroboration).toBe(0);
    expect(evaluated.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("momentum: 40/40")])
    );

    const baseline = evaluateDiscoveryCandidate(makeCandidate(), context(makeConfig()));
    expect(baseline.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("baseline-unknown")])
    );

    const again = evaluateDiscoveryCandidate(extreme, context(makeConfig()));
    expect(again.reasons).toEqual(evaluated.reasons);
  });

  it("never emits capture kinds or automatic work creation fields", () => {
    const queue = buildDiscoveryQueue([makeCandidate()], context(makeConfig()));
    for (const candidate of queue.candidates) {
      expect(DISCOVERY_DISPOSITIONS).toContain(candidate.disposition);
      expect(candidate).not.toHaveProperty("captureKind");
      expect(candidate).not.toHaveProperty("taskKind");
      expect(candidate).not.toHaveProperty("capture");
      expect(candidate).not.toHaveProperty("bugKind");
    }
    const dispositions = queue.candidates.map((candidate) => candidate.disposition);
    expect(dispositions).toEqual([expect.stringMatching(/^(new|watch|alert|tracked|suppressed)$/)]);
  });
});
