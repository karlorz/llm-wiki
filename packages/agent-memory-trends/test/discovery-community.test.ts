import { describe, expect, it } from "vitest";
import { parseResearchConfig, type ResearchConfig } from "../src/config.js";
import {
  COMMUNITY_MAX_FETCHES_PER_SOURCE,
  COMMUNITY_MAX_ITEMS_PER_SOURCE,
  DISCOVERY_ATTENTION_EVIDENCE_MAX,
  DISCOVERY_ATTENTION_EXCERPT_MAX,
  makeDiscoveryCandidate,
  type CommunityReference,
  type DiscoveryCandidate,
} from "../src/discovery-contracts.js";
import {
  collectCommunityReferences,
  createHackerNewsAdapter,
  createHuggingFaceAdapter,
  createJsonCommunityAdapter,
  type CommunityFetchClient,
} from "../src/discovery-community.js";
import {
  capCommunityReferencesPerRepository,
  dedupeCommunityReferences,
  extractCanonicalRepositoryUrls,
  makeCommunityReference,
  mergeCommunityReferences,
} from "../src/discovery-community-normalize.js";
import { err, ok, type Result } from "../src/types.js";

const COMMUNITY_CONFIG = `version: 2
project: llm-wiki
timezone: Asia/Hong_Kong
research_promotion:
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
      - id: promotion_relevance
        label: Promotion relevance lane
        window_days: 7
        date_field: pushed
        sort: updated
        order: desc
        per_page: 10
        quality_gate:
          min_stars: 0
          min_forks: 0
          min_evidence_families: 1
        queries:
          - id: promo-memory
            label: Promo memory query
            query: coding agent memory
  dedupe:
    digest_ttl_days: 7
  watchlist:
    auto_append:
      min_appearances: 3
      window_days: 14
      min_score: 65
    accepted: []
    rejected: []
    archived: []
discovery:
  enabled: true
  max_daily_candidates: 20
  retention_days: 30
  immediate_alert:
    enabled: true
    min_repository_signal: 30
    min_independent_signal_count: 2
  github:
    api_call_budget: 60
    max_search_queries: 24
    max_enrichments: 40
    new_release_lanes:
      - id: release_velocity
        label: New release velocity
        window_days: 2
        date_field: pushed
        sort: updated
        order: desc
        per_page: 10
        quality_gate:
          min_stars: 0
          min_forks: 0
          min_evidence_families: 1
        queries:
          - id: release-new
            label: New release query
            query: ""
  community_sources:
    - id: hacker_news
      enabled: true
      role: corroboration
    - id: hugging_face
      enabled: true
      role: corroboration
    - id: cn_community
      enabled: true
      role: discovery
`;

function loadConfig(): ResearchConfig {
  const parsed = parseResearchConfig(COMMUNITY_CONFIG, "test-config.yml");
  if (!parsed.ok) throw new Error(`fixture config failed to parse: ${parsed.error}`);
  return parsed.data;
}

/** Injected fetch fake; records every URL it is asked to fetch. */
function fakeFetch(handler: (url: string) => Result<unknown>): { client: CommunityFetchClient; calls: string[] } {
  const calls: string[] = [];
  return {
    client: {
      async fetchJson(url: string) {
        calls.push(url);
        return handler(url);
      },
    },
    calls,
  };
}

function ref(
  canonicalUrl: string,
  sourceId: string,
  sourceUrl: string,
  extra: Partial<Parameters<typeof makeCommunityReference>[0]> = {}
): CommunityReference {
  const made = makeCommunityReference({ canonicalUrl, sourceId, sourceUrl, ...extra });
  if (!made.ok) throw new Error(`fixture reference failed: ${made.error}`);
  return made.data;
}

function makeCandidate(canonicalUrl: string): DiscoveryCandidate {
  const fullName = canonicalUrl.slice("https://github.com/".length);
  return makeDiscoveryCandidate({
    canonicalUrl,
    fullName,
    owner: fullName.split("/")[0]!,
    name: fullName.split("/")[1]!,
    createdAt: "2025-01-01T00:00:00Z",
    pushedAt: "2026-08-01T00:00:00Z",
    stargazersCount: 42,
    forksCount: 7,
    archived: false,
    topics: ["agent-memory"],
    description: "Agent memory tooling",
    license: "mit",
    defaultBranch: "main",
    sourceIds: ["lane:release_velocity"],
    attentionEvidence: [],
    relevanceInput: 60,
    evidenceQualityInput: 0,
  });
}

const HN_FIREBASE_TOP = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ALGOLIA = "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=";
const HF_TRENDING = "https://huggingface.co/api/trending";

describe("extraction seam", () => {
  it("accepts direct repository links and explicit outbound links, deduplicated deterministically", () => {
    const urls = extractCanonicalRepositoryUrls({
      url: "https://github.com/OrgA/RepoA",
      links: ["https://GitHub.com/orgb/repo-b/", "https://github.com/OrgA/RepoA", "https://github.com/OrgC/Repo.C"],
    });
    expect(urls).toEqual([
      "https://github.com/orga/repoa",
      "https://github.com/orgb/repo-b",
      "https://github.com/orgc/repo.c",
    ]);
  });

  it("accepts a single string links field and ignores non-string entries", () => {
    expect(extractCanonicalRepositoryUrls({ links: "https://github.com/OrgA/RepoA" })).toEqual([
      "https://github.com/orga/repoa",
    ]);
    expect(extractCanonicalRepositoryUrls({ links: [42, null, "https://github.com/OrgB/RepoB"] })).toEqual([
      "https://github.com/orgb/repob",
    ]);
    expect(extractCanonicalRepositoryUrls({})).toEqual([]);
  });

  it("rejects profiles, issue/pull/tree/blob URLs, non-GitHub, malformed and qualified URLs", () => {
    const rejected = [
      "https://github.com/someone",
      "https://github.com/OrgA/RepoA/issues/1",
      "https://github.com/OrgA/RepoA/pull/2",
      "https://github.com/OrgA/RepoA/tree/main",
      "https://github.com/OrgA/RepoA/blob/main/x.ts",
      "https://github.com/OrgA/RepoA?tab=readme",
      "https://github.com/OrgA/RepoA#readme",
      "https://github.com:8443/OrgA/RepoA",
      "https://gitlab.com/OrgA/RepoA",
      "http://github.com/OrgA/RepoA",
      "github.com/OrgA/ClaimedRepo",
      "org/repo",
      "not a url",
      "https://github.com/OrgA/",
      "https://github.com//RepoA",
      "",
    ];
    expect(extractCanonicalRepositoryUrls({ url: rejected[0], links: rejected.slice(1) })).toEqual([]);
  });

  it("drops over-long scanned inputs instead of truncating them into a wrong repo", () => {
    const long = `https://github.com/OrgA/${"r".repeat(600)}`;
    expect(extractCanonicalRepositoryUrls({ links: [long] })).toEqual([]);
  });
});

describe("hacker news adapter", () => {
  const ITEMS: Record<number, unknown> = {
    1: {
      id: 1,
      by: "alice",
      score: 210,
      descendants: 43,
      time: 1750000000,
      title: "Agent memory for coding agents",
      url: "https://github.com/AcmeOrg/AgentMemory",
      text: "story body that must never be retained, DO NOT RETAIN env_value=leak_placeholder",
    },
    2: { id: 2, by: "bob", score: 5, time: 1750000001, title: "Not a repo", url: "https://example.com/x" },
    3: { id: 3, by: "carol", score: 99, descendants: 12, time: 1750000002, title: "PR link", url: "https://github.com/AcmeOrg/AgentMemory/pull/7" },
    4: "malformed",
    5: { id: 5, by: "dave", score: 300, descendants: 55, time: 1750000003, title: "Second repo", url: "https://github.com/OtherOrg/Repo-Name" },
  };
  for (let id = 6; id <= 9; id += 1) {
    ITEMS[id] = { id, by: "anon", score: 1, time: 1750000000 + id, title: `Item ${id}`, url: "https://example.com/other" };
  }

  it("normalizes only GitHub-linked items with bounded fetches, metadata summaries, and no story body", async () => {
    const { client, calls } = fakeFetch((url) => {
      if (url === HN_FIREBASE_TOP) return ok(Array.from({ length: 30 }, (_, index) => index + 1));
      const match = url.match(/\/item\/(\d+)\.json$/);
      const id = match ? Number(match[1]) : NaN;
      return ITEMS[id] !== undefined ? ok(ITEMS[id]) : err("NOT_FOUND", `no fixture for item ${id}`);
    });
    const config = loadConfig();
    config.discovery.communitySources = config.discovery.communitySources.filter((source) => source.id === "hacker_news");
    const result = await collectCommunityReferences(config, { fetchJson: client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(calls.length).toBe(1 + 9);
    expect(calls[0]).toBe(HN_FIREBASE_TOP);
    expect(calls.every((url) => !url.includes("algolia"))).toBe(true);
    expect(result.data.requestsUsed).toBe(1 + 9);
    expect(result.data.sources.attempted).toEqual(["hacker_news"]);
    expect(result.data.sources.skipped).toEqual([]);

    const references = result.data.references;
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({
      canonicalUrl: "https://github.com/acmeorg/agentmemory",
      sourceId: "hacker_news",
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      title: "Agent memory for coding agents",
      englishSummary: "HN story, score 210, 43 comments, by alice",
      observedAt: new Date(1750000000 * 1000).toISOString(),
    });
    expect(Object.keys(references[0]!).sort()).toEqual([
      "canonicalUrl",
      "englishSummary",
      "observedAt",
      "sourceId",
      "sourceUrl",
      "title",
    ]);
    expect(references[1]!.canonicalUrl).toBe("https://github.com/otherorg/repo-name");
    expect(result.data.warnings).toContain("community source hacker_news: malformed item 4");
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("DO NOT RETAIN");
    expect(serialized).not.toContain("leak_placeholder");
    expect(serialized).not.toContain("story body");
    expect(serialized).not.toContain("example.com/x");
  });

  it("omits an out-of-range finite timestamp with a warning instead of throwing, and other sources continue", async () => {
    const { client } = fakeFetch((url) => {
      if (url === HN_FIREBASE_TOP) return ok([1]);
      if (url.match(/\/item\/1\.json$/)) {
        return ok({
          id: 1,
          by: "alice",
          score: 5,
          time: 1e300,
          title: "Repo with absurd timestamp",
          url: "https://github.com/AcmeOrg/AgentMemory",
        });
      }
      if (url === HF_TRENDING) {
        return ok({
          trending: [{ repoData: { id: "org/ok-model", cardData: { github: "https://github.com/Org/OkModel" } } }],
        });
      }
      return err("NETWORK_FAILED", "unexpected url");
    });
    const config = loadConfig();
    config.discovery.communitySources = config.discovery.communitySources.filter(
      (source) => source.id === "hacker_news" || source.id === "hugging_face"
    );
    const result = await collectCommunityReferences(config, { fetchJson: client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hn = result.data.references.find((r) => r.sourceId === "hacker_news");
    expect(hn).toBeDefined();
    expect(hn!.canonicalUrl).toBe("https://github.com/acmeorg/agentmemory");
    expect(hn!.observedAt).toBeUndefined();
    expect(
      result.data.references.some(
        (r) => r.sourceId === "hugging_face" && r.canonicalUrl === "https://github.com/org/okmodel"
      )
    ).toBe(true);
    expect(result.data.warnings).toContain("community source hacker_news: item 1: invalid timestamp omitted");
  });

  it("falls back to the Algolia endpoint when Firebase fails, still bounded", async () => {
    const hits = [
      { objectID: "a1", title: "Agent memory roundup", url: "https://github.com/OrgA/RepoA", points: 120, num_comments: 30, created_at: "2026-08-01T00:00:00Z" },
      { objectID: "a2", title: "Plain blog", url: "https://example.com/x", points: 3, num_comments: 1, created_at: "2026-08-02T00:00:00Z" },
      { objectID: "a3", title: "Profile link", url: "https://github.com/someone", points: 8 },
      { objectID: "a4", title: "Second repo", url: "https://github.com/OrgB/RepoB", points: 55, num_comments: 9 },
    ];
    const { client, calls } = fakeFetch((url) =>
      url.includes("firebaseio") ? err("NETWORK_FAILED", "endpoint unavailable") : ok({ hits })
    );
    const adapter = createHackerNewsAdapter(client);
    const result = await adapter.fetchReferences({
      maxItems: COMMUNITY_MAX_ITEMS_PER_SOURCE,
      maxRequests: COMMUNITY_MAX_FETCHES_PER_SOURCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`${HN_ALGOLIA}${COMMUNITY_MAX_ITEMS_PER_SOURCE}`);
    expect(result.data.requestsUsed).toBe(2);
    expect(result.data.references.map((r) => r.canonicalUrl)).toEqual([
      "https://github.com/orga/repoa",
      "https://github.com/orgb/repob",
    ]);
    expect(result.data.references[0]).toMatchObject({
      sourceUrl: "https://news.ycombinator.com/item?id=a1",
      englishSummary: "HN story, score 120, 30 comments",
      observedAt: "2026-08-01T00:00:00Z",
    });
    expect(result.data.warnings.join(" ")).toContain("fell back to the Algolia endpoint");
  });
});

describe("hugging face adapter", () => {
  it("extracts strict GitHub links only from documented card fields, bounded and per-entry fault tolerant", async () => {
    const entries: unknown[] = [
      { repoData: { id: "org/model-one", likes: 42, cardData: { github: "https://github.com/Org/ModelOne", homepage: "https://github.com/Org/ModelOne" } } },
      { repoData: { id: "org/model-two", likes: 7, cardData: { description: "no links here" } } },
      { repoData: { id: "org/model-three", likes: 1, cardData: { github: "https://github.com/Someone" } } },
      "malformed",
      { repoData: { id: "org/model-four", likes: 9, cardData: { description: "See https://github.com/Org/DescriptionRepo for code" } } },
    ];
    for (let index = 5; index < 30; index += 1) {
      entries.push({ repoData: { id: `org/model-${index}`, likes: 1, cardData: {} } });
    }
    entries[25] = { repoData: { id: "org/model-late", cardData: { github: "https://github.com/Org/LateRepo" } } };

    const { client, calls } = fakeFetch((url) => (url === HF_TRENDING ? ok({ trending: entries }) : err("NETWORK_FAILED", "unexpected url")));
    const config = loadConfig();
    config.discovery.communitySources = config.discovery.communitySources.filter((source) => source.id === "hugging_face");
    const result = await collectCommunityReferences(config, { fetchJson: client });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(calls).toEqual([HF_TRENDING]);
    expect(result.data.requestsUsed).toBe(1);
    const references = result.data.references;
    expect(references).toHaveLength(1);
    expect(references[0]).toEqual({
      canonicalUrl: "https://github.com/org/modelone",
      sourceId: "hugging_face",
      sourceUrl: "https://huggingface.co/org/model-one",
      title: "org/model-one",
      englishSummary: "Trending on Hugging Face, 42 likes",
    });
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("huggingface.co/org/model-two");
    expect(serialized).not.toContain("DescriptionRepo");
    expect(serialized).not.toContain("LateRepo");
    expect(result.data.warnings).toContain("community source hugging_face: malformed trending entry");
  });
});

describe("json community adapter (China-region source)", () => {
  it("preserves original-language title/excerpt/language and emits a conservative English summary", async () => {
    const items = [
      {
        id: "e1",
        url: "https://community.example.com/entries/1",
        links: ["https://github.com/ZhOrg/RepoJia"],
        title: "智能体记忆开源仓库讨论",
        excerpt: "社区对开源智能体记忆仓库的讨论与评价",
        language: "zh",
        published_at: "2026-08-10T08:00:00+08:00",
      },
      {
        id: "e2",
        url: "https://community.example.com/entries/2",
        links: ["https://github.com/ZhOrg/RepoYi"],
        title: "第二篇",
        language: "zh",
        english_summary: "Community review of RepoYi.",
      },
      { id: "e3", url: "https://community.example.com/entries/3", links: ["https://github.com/Someone"], title: "个人主页" },
      { id: "e4", url: "not-a-url", links: ["https://github.com/ZhOrg/RepoSan"], title: "无有效链接" },
      "malformed",
      { id: "e6", url: "https://community.example.com/entries/6", title: "无链接条目" },
    ];
    const { client, calls } = fakeFetch((url) =>
      url === "https://feed.example.com/cn.json" ? ok({ items }) : err("NETWORK_FAILED", "unexpected url")
    );
    const config = loadConfig();
    config.discovery.communitySources = config.discovery.communitySources.filter((source) => source.id === "cn_community");
    const result = await collectCommunityReferences(config, {
      fetchJson: client,
      adapters: { cn_community: createJsonCommunityAdapter("cn_community", "https://feed.example.com/cn.json", client) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(calls).toEqual(["https://feed.example.com/cn.json"]);
    expect(result.data.requestsUsed).toBe(1);
    const references = result.data.references;
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({
      canonicalUrl: "https://github.com/zhorg/repojia",
      sourceId: "cn_community",
      sourceUrl: "https://community.example.com/entries/1",
      language: "zh",
      title: "智能体记忆开源仓库讨论",
      excerpt: "社区对开源智能体记忆仓库的讨论与评价",
      englishSummary: 'Community observation in zh: "智能体记忆开源仓库讨论"; no source-provided English summary',
      observedAt: "2026-08-10T08:00:00+08:00",
    });
    expect(references[1]!.englishSummary).toBe("Community review of RepoYi.");
    expect(references[1]!.language).toBe("zh");
    expect(result.data.warnings).toContain(
      "community source cn_community: item e4 skipped: expected a public http(s) source URL, got: not-a-url"
    );
    expect(result.data.warnings).toContain("community source cn_community: malformed item");
  });

  it("accepts a bare JSON array payload", async () => {
    const { client } = fakeFetch(() =>
      ok([
        { id: "b1", url: "https://community.example.com/entries/b1", links: ["https://github.com/OrgB/RepoB"], title: "标题", language: "zh" },
      ])
    );
    const adapter = createJsonCommunityAdapter("cn_community", "https://feed.example.com/cn.json", client);
    const result = await adapter.fetchReferences({ maxItems: 20, maxRequests: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.references).toHaveLength(1);
    expect(result.data.references[0]!.canonicalUrl).toBe("https://github.com/orgb/repob");
  });
});

describe("collector dispatch", () => {
  it("turns a failed source fetch, unknown adapter, and invalid payload into warnings while others continue", async () => {
    const config = loadConfig();
    config.discovery.communitySources.push({ id: "mystery_feed", enabled: true, role: "discovery" });
    const { client } = fakeFetch((url) => {
      if (url === HF_TRENDING) return ok({ trending: [{ repoData: { id: "org/ok-model", cardData: { github: "https://github.com/Org/OkModel" } } }] });
      if (url === "https://feed.example.com/cn.json") return ok({ items: "nope" });
      return err("NETWORK_FAILED", "endpoint unavailable");
    });
    const result = await collectCommunityReferences(config, {
      fetchJson: client,
      adapters: { cn_community: createJsonCommunityAdapter("cn_community", "https://feed.example.com/cn.json", client) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.references.map((r) => r.canonicalUrl)).toEqual(["https://github.com/org/okmodel"]);
    expect(result.data.warnings.some((w) => w.startsWith("community source hacker_news failed:"))).toBe(true);
    expect(result.data.warnings).toContain("community source mystery_feed is not registered; skipping");
    expect(result.data.warnings).toContain(
      "community source cn_community failed: expected a JSON array or an object with an items array"
    );
    expect(result.data.sources.attempted).toEqual(["hacker_news", "hugging_face", "cn_community"]);
    expect(result.data.sources.unknown).toEqual(["mystery_feed"]);
  });

  it("fails closed with DISCOVERY_DISABLED before any fetch when discovery is disabled", async () => {
    const config = loadConfig();
    config.discovery.enabled = false;
    const { client, calls } = fakeFetch(() => ok({}));
    const result = await collectCommunityReferences(config, { fetchJson: client });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("DISCOVERY_DISABLED");
    expect(calls).toHaveLength(0);
  });

  it("makes zero client calls for disabled sources and records them as skipped", async () => {
    const config = loadConfig();
    config.discovery.communitySources[0]!.enabled = false;
    const { client, calls } = fakeFetch((url) => {
      if (url === HF_TRENDING) return ok({ trending: [] });
      if (url === "https://feed.example.com/cn.json") return ok({ items: [] });
      return err("NETWORK_FAILED", "endpoint unavailable");
    });
    const result = await collectCommunityReferences(config, {
      fetchJson: client,
      adapters: { cn_community: createJsonCommunityAdapter("cn_community", "https://feed.example.com/cn.json", client) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls.every((url) => !url.includes("firebaseio") && !url.includes("algolia"))).toBe(true);
    expect(calls).toEqual([HF_TRENDING, "https://feed.example.com/cn.json"]);
    expect(result.data.sources.skipped).toEqual(["hacker_news"]);
    expect(result.data.sources.attempted).toEqual(["hugging_face", "cn_community"]);
  });

  it("deduplicates on canonical repository + source ID + source URL and orders deterministically", () => {
    const references = [
      ref("https://github.com/b/repo-b", "hacker_news", "https://news.ycombinator.com/item?id=2"),
      ref("https://github.com/a/repo-a", "hacker_news", "https://news.ycombinator.com/item?id=1"),
      ref("https://github.com/a/repo-a", "hacker_news", "https://news.ycombinator.com/item?id=1"),
      ref("https://github.com/a/repo-a", "cn_community", "https://community.example.com/entries/1"),
      ref("https://github.com/b/repo-b", "hacker_news", "https://news.ycombinator.com/item?id=2"),
    ];
    const deduped = dedupeCommunityReferences(references);
    expect(deduped).toHaveLength(3);
    const bounded = capCommunityReferencesPerRepository(deduped);
    expect(bounded.map((r) => r.canonicalUrl)).toEqual([
      "https://github.com/a/repo-a",
      "https://github.com/a/repo-a",
      "https://github.com/b/repo-b",
    ]);
  });
});

describe("bounds and privacy", () => {
  it("caps every retained text field at the attention excerpt cap", async () => {
    const title = "t".repeat(300);
    const excerpt = "e".repeat(300);
    const summary = "s".repeat(300);
    const { client } = fakeFetch(() =>
      ok({
        items: [
          {
            id: "c1",
            url: "https://community.example.com/entries/c1",
            links: ["https://github.com/OrgB/RepoB"],
            title,
            excerpt,
            language: "zh",
            english_summary: summary,
            published_at: "2026-08-01T00:00:00Z",
          },
        ],
      })
    );
    const adapter = createJsonCommunityAdapter("cn_community", "https://feed.example.com/cn.json", client);
    const result = await adapter.fetchReferences({ maxItems: 20, maxRequests: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reference = result.data.references[0]!;
    expect(reference.title).toHaveLength(DISCOVERY_ATTENTION_EXCERPT_MAX);
    expect(reference.excerpt).toHaveLength(DISCOVERY_ATTENTION_EXCERPT_MAX);
    expect(reference.englishSummary).toHaveLength(DISCOVERY_ATTENTION_EXCERPT_MAX);
  });

  it("caps references per canonical repository at the evidence max", () => {
    const references = Array.from({ length: DISCOVERY_ATTENTION_EVIDENCE_MAX + 7 }, (_, index) =>
      ref("https://github.com/a/repo-a", "hacker_news", `https://news.ycombinator.com/item?id=${index + 1}`)
    );
    references.push(ref("https://github.com/b/repo-b", "hacker_news", "https://news.ycombinator.com/item?id=900"));
    const bounded = capCommunityReferencesPerRepository(references);
    const repoA = bounded.filter((r) => r.canonicalUrl === "https://github.com/a/repo-a");
    expect(repoA).toHaveLength(DISCOVERY_ATTENTION_EVIDENCE_MAX);
    expect(bounded.some((r) => r.canonicalUrl === "https://github.com/b/repo-b")).toBe(true);
  });

  it("rejects invalid observation timestamps instead of retaining them", () => {
    const made = makeCommunityReference({
      canonicalUrl: "https://github.com/a/repo-a",
      sourceId: "cn_community",
      sourceUrl: "https://community.example.com/entries/1",
      englishSummary: "Summary",
      observedAt: "not-a-date",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.data.observedAt).toBeUndefined();
  });
});

describe("merge seam", () => {
  const VALID = ["hacker_news", "hugging_face", "cn_community"];

  it("attaches bounded evidence to a matching candidate only, preserving identity and public facts", () => {
    const candidate = makeCandidate("https://github.com/acmeorg/agentmemory");
    const merged = mergeCommunityReferences({
      candidate,
      references: [
        ref("https://github.com/acmeorg/agentmemory", "hacker_news", "https://news.ycombinator.com/item?id=1", {
          title: "Agent memory for coding agents",
          englishSummary: "HN story, score 210, 43 comments, by alice",
          observedAt: "2026-08-01T00:00:00Z",
        }),
        ref("https://github.com/otheroorg/repo-name", "hacker_news", "https://news.ycombinator.com/item?id=9"),
        ref("https://github.com/acmeorg/agentmemory", "cn_community", "https://community.example.com/entries/1", {
          language: "zh",
          excerpt: "社区讨论",
        }),
      ],
      validSourceIds: VALID,
    });

    expect(merged.canonicalUrl).toBe(candidate.canonicalUrl);
    expect(merged.fullName).toBe(candidate.fullName);
    expect(merged.stargazersCount).toBe(candidate.stargazersCount);
    expect(merged.forksCount).toBe(candidate.forksCount);
    expect(merged.archived).toBe(candidate.archived);
    expect(merged.topics).toEqual(candidate.topics);
    expect(merged.description).toBe(candidate.description);
    expect(merged.createdAt).toBe(candidate.createdAt);
    expect(merged.pushedAt).toBe(candidate.pushedAt);
    expect(merged.relevanceInput).toBe(candidate.relevanceInput);
    expect(merged.disposition).toBe("new");
    expect(merged.alert).toBe(false);
    expect(merged.promotionEligible).toBe(false);
    expect(merged.reasons).toEqual([]);
    expect(merged.score).toEqual(candidate.score);

    expect(merged.attentionEvidence).toEqual([
      { sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1", title: "Agent memory for coding agents", englishSummary: "HN story, score 210, 43 comments, by alice" },
      { sourceId: "cn_community", url: "https://community.example.com/entries/1", language: "zh", excerpt: "社区讨论", englishSummary: "Community observation" },
    ]);
    expect(merged.sourceIds).toEqual(["lane:release_velocity", "hacker_news", "cn_community"]);
    expect(merged.evidenceQualityInput).toBe(10);
  });

  it("adds only valid community source IDs to provenance and evidence", () => {
    const candidate = makeCandidate("https://github.com/acmeorg/agentmemory");
    const merged = mergeCommunityReferences({
      candidate,
      references: [
        ref("https://github.com/acmeorg/agentmemory", "hacker_news", "https://news.ycombinator.com/item?id=1"),
        ref("https://github.com/acmeorg/agentmemory", "mystery_feed", "https://mystery.example.com/1"),
      ],
      validSourceIds: ["hacker_news"],
    });
    expect(merged.attentionEvidence).toHaveLength(1);
    expect(merged.attentionEvidence[0]!.sourceId).toBe("hacker_news");
    expect(merged.sourceIds).toEqual(["lane:release_velocity", "hacker_news"]);
    expect(merged.evidenceQualityInput).toBe(5);
  });

  it("leaves the candidate untouched when no canonical URL matches", () => {
    const candidate = makeCandidate("https://github.com/acmeorg/agentmemory");
    const merged = mergeCommunityReferences({
      candidate,
      references: [ref("https://github.com/otheroorg/repo-name", "hacker_news", "https://news.ycombinator.com/item?id=1")],
      validSourceIds: VALID,
    });
    expect(merged).toEqual(candidate);
  });

  it("deduplicates references and existing evidence on source ID + source URL", () => {
    const candidate = makeCandidate("https://github.com/acmeorg/agentmemory");
    candidate.attentionEvidence = [
      { sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1", title: "Original" },
    ];
    const merged = mergeCommunityReferences({
      candidate,
      references: [
        ref("https://github.com/acmeorg/agentmemory", "hacker_news", "https://news.ycombinator.com/item?id=1", { title: "Duplicate" }),
        ref("https://github.com/acmeorg/agentmemory", "hacker_news", "https://news.ycombinator.com/item?id=1", { title: "Duplicate again" }),
        ref("https://github.com/acmeorg/agentmemory", "cn_community", "https://community.example.com/entries/1"),
      ],
      validSourceIds: VALID,
    });
    expect(merged.attentionEvidence).toEqual([
      { sourceId: "hacker_news", url: "https://news.ycombinator.com/item?id=1", title: "Original" },
      { sourceId: "cn_community", url: "https://community.example.com/entries/1", englishSummary: "Community observation" },
    ]);
    expect(merged.evidenceQualityInput).toBe(5);
  });

  it("caps appended evidence at the evidence max and never emits task/capture/promotion fields", () => {
    const candidate = makeCandidate("https://github.com/acmeorg/agentmemory");
    const references = Array.from({ length: DISCOVERY_ATTENTION_EVIDENCE_MAX + 5 }, (_, index) =>
      ref("https://github.com/acmeorg/agentmemory", "hacker_news", `https://news.ycombinator.com/item?id=${index + 1}`)
    );
    const merged = mergeCommunityReferences({ candidate, references, validSourceIds: VALID });
    expect(merged.attentionEvidence).toHaveLength(DISCOVERY_ATTENTION_EVIDENCE_MAX);
    expect(merged.evidenceQualityInput).toBe(100);
    expect(merged.sourceIds).toEqual(["lane:release_velocity", "hacker_news"]);

    const keys = Object.keys(merged).join(",");
    expect(keys).not.toMatch(/task|bug|idea|capture|synthesis/);
    const referenceKeys = Object.keys(references[0]!).join(",");
    expect(referenceKeys).not.toMatch(/task|bug|idea|capture|synthesis/);
    expect(merged.disposition).toBe("new");
    expect(merged.alert).toBe(false);
    expect(merged.promotionEligible).toBe(false);
  });
});
