import { describe, expect, it } from "vitest";
import { parseResearchConfig } from "../src/config.js";
import { collectDiscoveryCandidates } from "../src/discovery-github.js";
import type { GhRunResult, GhRunner } from "../src/github.js";

const DISCOVERY_CONFIG = `version: 2
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
          min_stars: 10
          min_forks: 0
          min_evidence_families: 2
        queries:
          - id: promo-memory
            label: Promo memory query
            query: coding agent memory in:name,description,readme
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
    relevance_lanes:
      - id: relevance_keyword
        label: Relevance keyword lane
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
          - id: relevance-keyword
            label: Relevance keyword query
            query: agent memory in:name,description,readme
  official_organizations:
    - github: deepseek-ai
      region: CN
      official_urls:
        - https://www.deepseek.com/
      categories:
        - models
  community_sources:
    - id: hacker_news
      enabled: true
      role: corroboration
    - id: hugging_face
      enabled: true
      role: corroboration
`;

const V1_CONFIG = `version: 1
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
  max_queries: 4
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
        min_stars: 0
        min_forks: 0
        min_evidence_families: 1
      queries:
        - id: daily-memory
          label: Daily coding-agent memory
          query: coding agent memory in:name,description,readme
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;

const NOW = new Date("2026-08-14T00:00:00Z");

function rateLimitJson(): string {
  return JSON.stringify({
    resources: {
      core: { remaining: 4900, limit: 5000, reset: 1781126400 },
      search: { remaining: 29, limit: 30, reset: 1781126400 },
    },
  });
}

function itemsJson(items: unknown[]): string {
  return JSON.stringify({ total_count: items.length, items });
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: "acme/memory",
    name: "memory",
    html_url: "https://github.com/acme/memory",
    description: "coding agent memory with markdown and sqlite",
    topics: ["agent-memory", "mcp"],
    stargazers_count: 120,
    forks_count: 10,
    pushed_at: "2026-08-13T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    archived: false,
    license: { spdx_id: "MIT" },
    default_branch: "main",
    ...overrides,
  };
}

function isSearchCall(args: string[]): boolean {
  return args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories";
}

function formValue(args: string[], key: string): string {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-f" && args[index + 1]!.startsWith(`${key}=`)) {
      return args[index + 1]!.slice(key.length + 1);
    }
  }
  return "";
}

function parseFixture(text: string, path: string) {
  const parsed = parseResearchConfig(text, path);
  if (!parsed.ok) throw new Error(`expected config to parse: ${String(parsed.detail)}`);
  return parsed.data;
}

describe("agent-memory-trends discovery GitHub collector", () => {
  it("preflights auth and rate limit exactly once, builds qualifier-only new-release searches, and attaches seeded-org provenance", async () => {
    const config = parseFixture(DISCOVERY_CONFIG, "discovery-test.yaml");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) {
        const query = formValue(args, "q");
        if (query.startsWith("org:deepseek-ai")) {
          return {
            exitCode: 0,
            stdout: itemsJson([
              item({
                full_name: "DeepSeek-AI/chat",
                name: "chat",
                html_url: "https://github.com/DeepSeek-AI/chat/",
                description: "deepseek chat client",
                topics: ["agent-memory"],
                stargazers_count: 1234,
                forks_count: 100,
                pushed_at: "2026-08-13T00:00:00Z",
                created_at: "2026-01-01T00:00:00Z",
              }),
            ]),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: itemsJson([item()]), stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectDiscoveryCandidates(config, { runGh: runner, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    expect(calls[0]).toEqual(["auth", "status"]);
    expect(calls[1]).toEqual(["api", "rate_limit"]);

    const searchCalls = calls.filter(isSearchCall);
    expect(searchCalls).toHaveLength(3);
    const laneSearch = searchCalls.find((args) => !formValue(args, "q").startsWith("org:"));
    expect(formValue(laneSearch!, "q")).toBe("pushed:>=2026-08-12");
    const orgSearch = searchCalls.find((args) => formValue(args, "q").startsWith("org:deepseek-ai"));
    expect(formValue(orgSearch!, "q")).toBe("org:deepseek-ai pushed:>=2026-08-07");

    expect(result.data.apiCallsUsed).toBe(4);
    expect(result.data.searchQueriesUsed).toBe(3);
    expect(result.data.enrichmentsUsed).toBe(0);
    expect(result.data.warnings).toEqual([]);

    const orgCandidate = result.data.candidates.find(
      (candidate) => candidate.canonicalUrl === "https://github.com/deepseek-ai/chat"
    );
    expect(orgCandidate).toBeDefined();
    expect(orgCandidate!.owner).toBe("deepseek-ai");
    expect(orgCandidate!.sourceIds).toContain("github_org_seed:deepseek-ai");

    expect(calls.some((args) => args[0] === "api" && args[1]?.includes("/readme"))).toBe(false);
  });

  it("merges candidates by canonical repository URL and skips invalid repository items", async () => {
    const config = parseFixture(DISCOVERY_CONFIG, "discovery-test.yaml");

    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) {
        const query = formValue(args, "q");
        if (query.startsWith("org:deepseek-ai")) {
          return { exitCode: 0, stdout: itemsJson([]), stderr: "" };
        }
        if (query.startsWith("pushed:>=")) {
          return {
            exitCode: 0,
            stdout: itemsJson([item({ html_url: "https://github.com/Acme/Memory/" })]),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: itemsJson([
            item({ html_url: "https://github.com/acme/memory" }),
            item({ full_name: "acme/bad", name: "bad", html_url: "https://example.com/acme/bad" }),
            item({ full_name: "acme/not-a-repo", name: "not-a-repo", html_url: "https://github.com/acme" }),
            item({ full_name: "acme/tree", name: "tree", html_url: "https://github.com/acme/memory/tree/main" }),
            { name: "missing-url", html_url: "https://github.com/acme/x" },
          ]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectDiscoveryCandidates(config, { runGh: runner, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    expect(result.data.warnings).toEqual([]);

    expect(result.data.candidates).toHaveLength(1);
    const merged = result.data.candidates[0]!;
    expect(merged.canonicalUrl).toBe("https://github.com/acme/memory");
    expect(merged.sourceIds).toEqual([
      "lane:release_velocity",
      "query:release-new",
      "lane:relevance_keyword",
      "query:relevance-keyword",
    ]);
  });

  it("enforces apiCallBudget, maxSearchQueries, and maxEnrichments separately", async () => {
    const text = DISCOVERY_CONFIG.replace("api_call_budget: 60", "api_call_budget: 4")
      .replace("max_search_queries: 24", "max_search_queries: 1")
      .replace("max_enrichments: 40", "max_enrichments: 1");
    const config = parseFixture(text, "discovery-budget.yaml");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) {
        return {
          exitCode: 0,
          stdout: itemsJson([
            item({ full_name: "acme/first", name: "first", html_url: "https://github.com/acme/first", created_at: undefined, license: undefined, default_branch: undefined }),
            item({ full_name: "acme/second", name: "second", html_url: "https://github.com/acme/second", created_at: undefined, license: undefined, default_branch: undefined }),
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            created_at: "2026-06-01T00:00:00Z",
            license: { spdx_id: "MIT" },
            default_branch: "main",
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectDiscoveryCandidates(config, { runGh: runner, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");

    expect(result.data.apiCallsUsed).toBe(3);
    expect(result.data.searchQueriesUsed).toBe(1);
    expect(result.data.enrichmentsUsed).toBe(1);

    const first = result.data.candidates.find((candidate) => candidate.fullName === "acme/first");
    const second = result.data.candidates.find((candidate) => candidate.fullName === "acme/second");
    expect(first!.createdAt).toBe("2026-06-01T00:00:00Z");
    expect(first!.license).toBe("MIT");
    expect(first!.defaultBranch).toBe("main");
    expect(second!.createdAt).toBeNull();
    expect(second!.license).toBeNull();
  });

  it("stops all collection when the API call budget is exhausted", async () => {
    const text = DISCOVERY_CONFIG.replace("api_call_budget: 60", "api_call_budget: 3");
    const config = parseFixture(text, "discovery-api-budget.yaml");

    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) {
        return {
          exitCode: 0,
          stdout: itemsJson([item({ created_at: undefined, license: undefined, default_branch: undefined })]),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectDiscoveryCandidates(config, { runGh: runner, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    expect(result.data.apiCallsUsed).toBe(3);
    expect(result.data.searchQueriesUsed).toBe(2);
    expect(result.data.enrichmentsUsed).toBe(0);
    expect(result.data.candidates[0]!.createdAt).toBeNull();
  });

  it("fails closed when discovery is disabled without calling the runner", async () => {
    const v1 = parseFixture(V1_CONFIG, "v1.yaml");
    const disabledText = DISCOVERY_CONFIG.replace("discovery:\n  enabled: true", "discovery:\n  enabled: false");
    const v2Disabled = parseFixture(disabledText, "v2-disabled.yaml");

    let calls = 0;
    const runner: GhRunner = async () => {
      calls += 1;
      throw new Error("runner must not be called when discovery is disabled");
    };

    const v1Result = await collectDiscoveryCandidates(v1, { runGh: runner, now: NOW });
    expect(v1Result.ok).toBe(false);
    if (v1Result.ok) throw new Error("expected failure");
    expect(v1Result.error).toBe("DISCOVERY_DISABLED");

    const v2Result = await collectDiscoveryCandidates(v2Disabled, { runGh: runner, now: NOW });
    expect(v2Result.ok).toBe(false);
    if (v2Result.ok) throw new Error("expected failure");
    expect(v2Result.error).toBe("DISCOVERY_DISABLED");

    expect(calls).toBe(0);
  });

  it("returns structured Result failures for auth, rate-limit, and search errors", async () => {
    const config = parseFixture(DISCOVERY_CONFIG, "discovery-test.yaml");

    const authFailure: GhRunner = async (args: string[]) => {
      if (args[0] === "auth" && args[1] === "status") {
        return { exitCode: 1, stdout: "", stderr: "not logged in" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const authResult = await collectDiscoveryCandidates(config, { runGh: authFailure, now: NOW });
    expect(authResult.ok).toBe(false);
    if (authResult.ok) throw new Error("expected failure");
    expect(authResult.error).toBe("GH_AUTH_FAILED");

    const rateLimitFailure: GhRunner = async (args: string[]) => {
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: "not json at all", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const rateLimitResult = await collectDiscoveryCandidates(config, { runGh: rateLimitFailure, now: NOW });
    expect(rateLimitResult.ok).toBe(false);
    if (rateLimitResult.ok) throw new Error("expected failure");
    expect(rateLimitResult.error).toBe("GH_RATE_LIMIT_PARSE_FAILED");

    const searchFailure: GhRunner = async (args: string[]) => {
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) return { exitCode: 1, stdout: "", stderr: "rate limit exceeded" };
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const searchResult = await collectDiscoveryCandidates(config, { runGh: searchFailure, now: NOW });
    expect(searchResult.ok).toBe(false);
    if (searchResult.ok) throw new Error("expected failure");
    expect(searchResult.error).toBe("GH_API_FAILED");
  });

  it("keeps candidates with a structured warning when metadata enrichment fails and never fetches README bodies", async () => {
    const config = parseFixture(DISCOVERY_CONFIG, "discovery-test.yaml");

    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      if (args[0] === "auth" && args[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "api" && args[1] === "rate_limit") {
        return { exitCode: 0, stdout: rateLimitJson(), stderr: "" };
      }
      if (isSearchCall(args)) {
        return {
          exitCode: 0,
          stdout: itemsJson([
            item({ full_name: "acme/memory", created_at: undefined, license: undefined, default_branch: undefined }),
          ]),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1] === "/repos/acme/memory") {
        return { exitCode: 1, stdout: "", stderr: "Not Found" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectDiscoveryCandidates(config, { runGh: runner, now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    expect(result.data.warnings).toHaveLength(1);
    expect(result.data.warnings[0]).toContain("acme/memory");
    expect(result.data.enrichmentsUsed).toBe(1);
    expect(result.data.candidates).toHaveLength(1);
    expect(result.data.candidates[0]!.createdAt).toBeNull();
  });
});
