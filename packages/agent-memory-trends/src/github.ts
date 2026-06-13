import { normalizeCanonicalUrl, type GithubLane, type GithubQualityGate, type ResearchConfig, type ResearchQuery } from "./config.js";
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
  laneIds: string[];
  qualityGate: "passed" | "multi_query_exception" | "failed";
  evidenceFamilies: string[];
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
  laneIds: string[];
  qualityGate: "passed" | "multi_query_exception" | "failed";
  evidenceFamilies: string[];
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
  let queriesUsed = 0;
  for (const lane of config.github.lanes) {
    for (const query of lane.queries) {
      if (queriesUsed >= config.github.maxQueries || apiCallsUsed >= config.github.apiCallBudget) break;
      const search = await searchRepositories(options.runGh, lane, query, options.now);
      apiCallsUsed += 1;
      queriesUsed += 1;
      if (!search.ok) return search;

      for (const item of search.data) {
        const candidate = parseSearchItem(item, lane.id, query.id);
        if (!candidate) continue;
        const existing = byUrl.get(candidate.canonicalUrl);
        if (existing) mergeCandidate(existing, candidate);
        else byUrl.set(candidate.canonicalUrl, candidate);
      }
    }
  }

  const unfilteredCandidates = [...byUrl.values()];
  for (const candidate of unfilteredCandidates) {
    if (apiCallsUsed >= config.github.apiCallBudget) break;
    const readme = await fetchReadme(options.runGh, candidate.fullName);
    apiCallsUsed += 1;
    if (readme.ok) {
      candidate.readmeText = readme.data;
      candidate.readmeEvidence = extractReadmeEvidence(candidate);
    }
    candidate.evidenceFamilies = extractEvidenceFamilies(candidate);
    candidate.qualityGate = evaluateCandidateQualityGate(candidate, config.github.lanes);
  }

  const rawCandidates = unfilteredCandidates
    .filter((candidate) => candidate.qualityGate !== "failed")
    .slice(0, config.github.maxRawCandidates);

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
      supportsClaim: "README evidence mentions coding-agent memory or workflow implementation signals.",
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
    /\b(agent[- ]memory|coding agent|checkpoint|session continuity|codex|claude|mcp|markdown|knowledge base|local[- ]first|local search|database|sync|hook|hooks|skill|skills|subagent|distill|dream|judge|sqlite|obsidian)\b/i.test(
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

async function searchRepositories(
  runGh: GhRunner,
  lane: GithubLane,
  query: ResearchQuery,
  now: Date
): Promise<Result<SearchRepositoryItem[]>> {
  const result = await ghApi(runGh, [
    "--method",
    "GET",
    "/search/repositories",
    "-f",
    `q=${qualifyQuery(query.query, lane, now)}`,
    "-f",
    `sort=${lane.sort}`,
    "-f",
    `order=${lane.order}`,
    "-f",
    `per_page=${lane.perPage}`,
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

function parseSearchItem(item: SearchRepositoryItem, laneId: string, queryId: string): RawCandidate | undefined {
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
    laneIds: [laneId],
    qualityGate: "failed",
    evidenceFamilies: [],
  };
}

function mergeCandidate(existing: RawCandidate, incoming: RawCandidate): void {
  existing.queryIds = unique([...existing.queryIds, ...incoming.queryIds]);
  existing.laneIds = unique([...existing.laneIds, ...incoming.laneIds]);
  existing.stargazersCount = Math.max(existing.stargazersCount, incoming.stargazersCount);
  existing.forksCount = Math.max(existing.forksCount, incoming.forksCount);
  if (Date.parse(incoming.pushedAt) > Date.parse(existing.pushedAt)) existing.pushedAt = incoming.pushedAt;
  if (!existing.description && incoming.description) existing.description = incoming.description;
  existing.topics = unique([...existing.topics, ...incoming.topics]);
  existing.archived = existing.archived && incoming.archived;
}

function qualifyQuery(query: string, lane: GithubLane, now: Date): string {
  if (lane.windowDays <= 0) return query;
  const cutoff = new Date(now.getTime() - lane.windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `${query} ${lane.dateField}:>=${cutoff}`;
}

function evaluateCandidateQualityGate(
  candidate: RawCandidate,
  lanes: GithubLane[]
): "passed" | "multi_query_exception" | "failed" {
  const candidateLanes = lanes.filter((lane) => candidate.laneIds.includes(lane.id));
  let hasException = false;
  for (const lane of candidateLanes) {
    const gate = lane.qualityGate;
    if (passesPrimaryGate(candidate, gate)) return "passed";
    if (passesMultiQueryException(candidate, gate) || passesStrongEvidenceException(candidate, gate)) {
      hasException = true;
    }
  }
  return hasException ? "multi_query_exception" : "failed";
}

function passesPrimaryGate(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  return passesAuthorityGate(candidate, gate) && candidate.evidenceFamilies.length >= gate.minEvidenceFamilies;
}

function passesAuthorityGate(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  const starsPass = gate.minStars <= 0 || candidate.stargazersCount >= gate.minStars;
  const forksPass = gate.minForks <= 0 || candidate.forksCount >= gate.minForks;
  if (gate.minStars > 0 && gate.minForks > 0) return starsPass || forksPass;
  return starsPass && forksPass;
}

function passesMultiQueryException(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  return (
    gate.allowMultiQueryException &&
    candidate.queryIds.length >= 2 &&
    candidate.evidenceFamilies.length >= Math.max(2, gate.minEvidenceFamilies)
  );
}

function passesStrongEvidenceException(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  return gate.allowStrongEvidenceException && candidate.evidenceFamilies.length >= Math.max(3, gate.minEvidenceFamilies);
}

function extractEvidenceFamilies(candidate: CandidateForScoring): string[] {
  const text = [
    candidate.name,
    candidate.fullName,
    candidate.description,
    candidate.topics.join(" "),
    candidate.readmeText,
  ]
    .join("\n")
    .toLowerCase();

  const matchers: Array<[string, RegExp]> = [
    ["coding_agent", /\b(coding agent|code agent|codex|claude|opencode|autonomous coding|agentic coding)\b/],
    ["memory_state", /\b(memory|checkpoint|session continuity|session-continuity|context consolidation|cross-session|state)\b/],
    ["workflow_distillation", /\b(distill|distillation|dream|reflection|workflow|lesson|summarize|consolidation)\b/],
    ["skills_subagents", /\b(skill|skills|subagent|sub-agent|hook|hooks|command|commands)\b/],
    ["goal_judge", /\b(goal|judge|eval|evaluation|benchmark)\b/],
    ["knowledge_store", /\b(sqlite|database|local search|vector|search|markdown|wiki|vault|knowledge base|trajectory|trajectories)\b/],
    ["self_improvement", /\b(self[- ]improv|autonomous|feedback|iteration|learn)\b/],
  ];

  return matchers.filter(([, pattern]) => pattern.test(text)).map(([family]) => family);
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

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
