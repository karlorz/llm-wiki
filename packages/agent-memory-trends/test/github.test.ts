import { describe, expect, it } from "vitest";
import { parseResearchConfig } from "../src/config.js";
import { collectGithubCandidates, type GhRunResult, type GhRunner } from "../src/github.js";

const CONFIG = `version: 1
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
    - { id: claude-agent-memory, label: Claude agent memory, query: "claude agent memory in:name,description,readme" }
    - { id: codex-agent-memory, label: Codex agent memory, query: "codex agent memory in:name,description,readme" }
    - { id: cross-agent-memory, label: cross-agent memory, query: "cross agent memory in:name,description,readme" }
    - { id: session-continuity-agent, label: session continuity agent, query: "session continuity agent in:name,description,readme" }
    - { id: mcp-memory, label: MCP memory, query: "MCP memory agent in:name,description,readme" }
    - { id: obsidian-agent-memory, label: Obsidian agent memory, query: "obsidian agent memory in:name,description,readme" }
    - { id: markdown-knowledge-base-agent, label: Markdown knowledge base agent, query: "markdown knowledge base agent in:name,description,readme" }
    - { id: sqlite-agent-memory, label: SQLite agent memory, query: "sqlite agent memory in:name,description,readme" }
    - { id: second-brain-agent-memory, label: second brain agent memory, query: "second brain agent memory in:name,description,readme" }
    - { id: local-first-memory-sync, label: local-first memory sync, query: "local first memory sync in:name,description,readme" }
watchlist:
  auto_append: { min_appearances: 3, window_days: 14, min_score: 65 }
  accepted: []
  rejected: []
  archived: []
`;

describe("agent-memory-trends GitHub collector", () => {
  it("preflights gh auth, checks rate limits, searches repositories, fetches READMEs, and respects budgets", async () => {
    const parsed = parseResearchConfig(CONFIG, "github-test.yaml");
    if (!parsed.ok) throw new Error("expected config to parse");

    const calls: string[][] = [];
    const runner: GhRunner = async (args: string[]): Promise<GhRunResult> => {
      calls.push(args);
      if (args[0] === "auth" && args[1] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "api" && args[1] === "rate_limit") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            resources: {
              core: { remaining: 4900, limit: 5000, reset: 1781126400 },
              search: { remaining: 29, limit: 30, reset: 1781126400 },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories") {
        const query = args[args.indexOf("-f") + 1]?.replace(/^q=/, "") ?? "unknown";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            total_count: 6,
            items: Array.from({ length: 6 }, (_, index) => ({
              name: `memory-${query.slice(0, 8)}-${index}`,
              full_name: `acme/memory-${query.slice(0, 8)}-${index}`,
              html_url: `https://github.com/acme/memory-${query.slice(0, 8)}-${index}`,
              description: "MCP agent memory with Markdown, SQLite, and session continuity.",
              topics: ["agent-memory", "mcp", "markdown", "sqlite"],
              stargazers_count: 100 + index,
              forks_count: 20,
              pushed_at: "2026-06-10T00:00:00Z",
              archived: false,
            })),
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme")) {
        const readme = [
          "# Local Agent Memory",
          "",
          "Markdown knowledge base, local-first sync, Codex and Claude memory hooks.",
          "",
          "Irrelevant implementation notes. ".repeat(200),
        ].join("\n");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            encoding: "base64",
            content: Buffer.from(readme).toString("base64"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const result = await collectGithubCandidates(parsed.data, {
      runGh: runner,
      now: new Date("2026-06-11T00:10:00+08:00"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected collector success");
    expect(calls[0]).toEqual(["auth", "status"]);
    expect(calls[1]).toEqual(["api", "rate_limit"]);
    expect(calls.filter((args) => args[0] === "api" && args[1] === "--method" && args[2] === "GET" && args[3] === "/search/repositories")).toHaveLength(10);
    expect(calls.some((args) => args[0] === "api" && args[1]?.startsWith("/repos/") && args[1]?.endsWith("/readme"))).toBe(
      true
    );
    expect(result.data.apiCallsUsed).toBeLessThanOrEqual(100);
    expect(result.data.rawCandidateCount).toBe(50);
    expect(result.data.selectedCandidates).toHaveLength(10);
    expect(result.data.selectedCandidates[0].readmeEvidence).toEqual([
      {
        sourceUrl: expect.stringMatching(/^https:\/\/github\.com\/acme\/memory-.*#readme$/),
        excerpt: "Markdown knowledge base, local-first sync, Codex and Claude memory hooks.",
        supportsClaim: "README evidence mentions agent-memory-relevant implementation signals.",
        confidence: "medium",
      },
    ]);
    const readmeEvidence = result.data.selectedCandidates[0].readmeEvidence ?? [];
    expect(readmeEvidence[0]?.excerpt.length).toBeLessThanOrEqual(600);
    expect(result.data.selectedCandidates[0].readmeText.length).toBeGreaterThan(
      readmeEvidence[0]?.excerpt.length ?? 0
    );
    expect(result.data.rateLimit.resources.search.remaining).toBe(29);
    expect(result.data.runSummary).toMatchObject({
      rawCandidateCount: 50,
      selectedCandidateCount: 10,
      apiCallsUsed: result.data.apiCallsUsed,
    });
  });
});
