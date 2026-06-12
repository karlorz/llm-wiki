import { normalizeCanonicalUrl, type ResearchConfig, type ResearchQuery } from "./config.js";
import { err, ok, type Result } from "./types.js";
import { scoreCandidate, type CandidateForScoring, type CandidateScore } from "./score.js";
import type { ProposalEvidence } from "./synthesis.js";

export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GhRunner = (args: string[]) => Promise<GhRunResult>;

export interface GithubCollectorOptions {
  runGh: GhRunner;
  now: Date;
  knownCanonicalUrls?: string[];
  existingTaskUrls?: string[];
}

export interface RateLimitState {
  resources: {
    core: {
      remaining: number;
      limit: number;
      reset: number;
    };
    search: {
      remaining: number;
      limit: number;
      reset: number;
    };
  };
}

export interface SelectedGithubCandidate extends CandidateForScoring {
  queryIds: string[];
  score: CandidateScore;
}

export interface GithubCollectionOutput {
  rateLimit: RateLimitState;
  apiCallsUsed: number;
  rawCandidateCount: number;
  selectedCandidates: SelectedGithubCandidate[];
  runSummary: {
    rawCandidateCount: number;
    selectedCandidateCount: number;
    apiCallsUsed: number;
  };
}

interface SearchRepositoryItem {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  topics?: unknown;
  stargazers_count?: unknown;
  forks_count?: unknown;
  pushed_at?: unknown;
  archived?: unknown;
}

interface RawCandidate extends CandidateForScoring {
  queryIds: string[];
}

export async function collectGithubCandidates(
  config: ResearchConfig,
  options: GithubCollectorOptions
): Promise<Result<GithubCollectionOutput>> {
  const auth = await options.runGh(["auth", "status"]);
  if (auth.exitCode !== 0) return err("GH_AUTH_FAILED", auth.stderr || auth.stdout);

  let apiCallsUsed = 0;
  const rateLimitResult = await ghApi(options.runGh, ["rate_limit"]);
  apiCallsUsed += 1;
  if (!rateLimitResult.ok) return rateLimitResult;
  const rateLimit = parseRateLimit(rateLimitResult.data.stdout);

  const byUrl = new Map<string, RawCandidate>();
  for (const query of config.github.queries.slice(0, config.github.maxQueries)) {
    if (apiCallsUsed >= config.github.apiCallBudget) break;
    const search = await searchRepositories(options.runGh, query);
    apiCallsUsed += 1;
    if (!search.ok) return search;

    for (const item of search.data) {
      if (byUrl.size >= config.github.maxRawCandidates) break;
      const candidate = parseSearchItem(item, query.id);
      if (!candidate) continue;
      const existing = byUrl.get(candidate.canonicalUrl);
      if (existing) {
        existing.queryIds.push(query.id);
      } else {
        byUrl.set(candidate.canonicalUrl, candidate);
      }
    }
  }

  const rawCandidates = [...byUrl.values()].slice(0, config.github.maxRawCandidates);
  for (const candidate of rawCandidates) {
    if (apiCallsUsed >= config.github.apiCallBudget) break;
    const readme = await fetchReadme(options.runGh, candidate.fullName);
    apiCallsUsed += 1;
    if (readme.ok) {
      candidate.readmeText = readme.data;
      candidate.readmeEvidence = extractReadmeEvidence(candidate);
    }
  }

  const selectedCandidates = rawCandidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate, {
        now: options.now,
        knownCanonicalUrls: options.knownCanonicalUrls ?? [],
        existingTaskUrls: options.existingTaskUrls ?? [],
      }),
    }))
    .sort((left, right) => right.score.score - left.score.score || left.fullName.localeCompare(right.fullName))
    .slice(0, config.github.maxSelectedCandidates);

  return ok({
    rateLimit,
    apiCallsUsed,
    rawCandidateCount: rawCandidates.length,
    selectedCandidates,
    runSummary: {
      rawCandidateCount: rawCandidates.length,
      selectedCandidateCount: selectedCandidates.length,
      apiCallsUsed,
    },
  });
}

function extractReadmeEvidence(candidate: CandidateForScoring): ProposalEvidence[] {
  const excerpt = selectReadmeExcerpt(candidate.readmeText);
  if (!excerpt) return [];
  return [
    {
      sourceUrl: `${candidate.canonicalUrl}#readme`,
      excerpt,
      supportsClaim: "README evidence mentions agent-memory-relevant implementation signals.",
      confidence: "medium",
    },
  ];
}

function selectReadmeExcerpt(readmeText: string): string {
  const paragraphs = readmeText
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("#"));

  const matched = paragraphs.find((paragraph) =>
    /\b(agent[- ]memory|session continuity|codex|claude|mcp|markdown|knowledge base|local[- ]first|sync|hook|hooks|sqlite|obsidian)\b/i.test(
      paragraph
    )
  );
  return matched ? clampExcerpt(matched) : "";
}

function clampExcerpt(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 600) return normalized;
  return `${normalized.slice(0, 597).trimEnd()}...`;
}

async function searchRepositories(runGh: GhRunner, query: ResearchQuery): Promise<Result<SearchRepositoryItem[]>> {
  const result = await ghApi(runGh, [
    "--method",
    "GET",
    "/search/repositories",
    "-f",
    `q=${query.query}`,
    "-f",
    "sort=updated",
    "-f",
    "order=desc",
    "-f",
    "per_page=10",
  ]);
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  const items = parsed.data.items;
  return ok(Array.isArray(items) ? (items as SearchRepositoryItem[]) : []);
}

async function fetchReadme(runGh: GhRunner, fullName: string): Promise<Result<string>> {
  const result = await ghApi(runGh, [`/repos/${fullName}/readme`]);
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.data.encoding !== "base64" || typeof parsed.data.content !== "string") return ok("");
  return ok(Buffer.from(parsed.data.content, "base64").toString("utf8"));
}

async function ghApi(runGh: GhRunner, args: string[]): Promise<Result<GhRunResult>> {
  const result = await runGh(["api", ...args]);
  if (result.exitCode !== 0) return err("GH_API_FAILED", result.stderr || result.stdout);
  return ok(result);
}

function parseSearchItem(item: SearchRepositoryItem, queryId: string): RawCandidate | undefined {
  if (typeof item.full_name !== "string" || typeof item.html_url !== "string" || typeof item.name !== "string") {
    return undefined;
  }

  return {
    name: item.name,
    fullName: item.full_name,
    canonicalUrl: normalizeCanonicalUrl(item.html_url),
    description: typeof item.description === "string" ? item.description : "",
    topics: Array.isArray(item.topics) ? item.topics.filter((topic): topic is string => typeof topic === "string") : [],
    readmeText: "",
    stargazersCount: typeof item.stargazers_count === "number" ? item.stargazers_count : 0,
    forksCount: typeof item.forks_count === "number" ? item.forks_count : 0,
    pushedAt: typeof item.pushed_at === "string" ? item.pushed_at : "",
    archived: typeof item.archived === "boolean" ? item.archived : false,
    queryIds: [queryId],
  };
}

function parseRateLimit(text: string): RateLimitState {
  const parsed = JSON.parse(text) as RateLimitState;
  return parsed;
}

function parseJsonObject(text: string): Result<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return err("INVALID_JSON", "expected object");
    return ok(parsed as Record<string, unknown>);
  } catch (error) {
    return err("INVALID_JSON", error instanceof Error ? error.message : String(error));
  }
}
