import type { GithubLane, ResearchConfig, ResearchQuery } from "./config.js";
import {
  canonicalizeDiscoveryRepositoryUrl,
  makeDiscoveryCandidate,
  type DiscoveryAttentionEvidence,
  type DiscoveryCandidate,
} from "./discovery-contracts.js";
import type { GhRunner, GhRunResult, RateLimitState } from "./github.js";
import { err, ok, type Result } from "./types.js";

/**
 * GitHub-only discovery collector for the recall-first discovery ladder.
 * Injected GhRunner, injected clock, no network beyond the runner, no README
 * body fetching, no community/news adapters. Output candidates carry
 * pre-ranking defaults; scoring/deltas are applied by later pipeline stages.
 */

export interface DiscoveryCollectorOptions {
  runGh: GhRunner;
  now: Date;
}

export interface DiscoveryCollectionOutput {
  rateLimit: RateLimitState;
  apiCallsUsed: number;
  searchQueriesUsed: number;
  enrichmentsUsed: number;
  candidates: DiscoveryCandidate[];
  warnings: string[];
  runSummary: {
    candidateCount: number;
    apiCallsUsed: number;
    searchQueriesUsed: number;
    enrichmentsUsed: number;
  };
}

/** Bounded time window for official-organization seed repository searches. */
const DISCOVERY_ORG_SEED_WINDOW_DAYS = 7;
const DISCOVERY_ORG_SEED_PER_PAGE = 10;
const GITHUB_REPOSITORY_SEARCH_PATH = "/search/repositories";

interface SearchRepositoryItem {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  topics?: unknown;
  stargazers_count?: unknown;
  forks_count?: unknown;
  pushed_at?: unknown;
  created_at?: unknown;
  archived?: unknown;
  license?: unknown;
  default_branch?: unknown;
}

/**
 * Collect discovery candidates from configured GitHub discovery lanes plus
 * the official-organization seed path. Fails closed when discovery is
 * disabled (checked before any other discovery field is read).
 */
export async function collectDiscoveryCandidates(
  config: ResearchConfig,
  options: DiscoveryCollectorOptions
): Promise<Result<DiscoveryCollectionOutput>> {
  if (!config.discovery.enabled) {
    return err("DISCOVERY_DISABLED", "discovery is disabled in configuration; refusing to collect");
  }

  const auth = await options.runGh(["auth", "status"]);
  if (auth.exitCode !== 0) return err("GH_AUTH_FAILED", auth.stderr || auth.stdout);

  const budget = config.discovery.github;
  const usage = { apiCallsUsed: 0, searchQueriesUsed: 0, enrichmentsUsed: 0 };

  const rateLimitResult = await ghApi(options.runGh, ["rate_limit"]);
  usage.apiCallsUsed += 1;
  if (!rateLimitResult.ok) return rateLimitResult;
  const rateLimit = parseRateLimit(rateLimitResult.data.stdout);
  if (!rateLimit.ok) return rateLimit;

  const byUrl = new Map<string, DiscoveryCandidate>();
  const warnings: string[] = [];

  for (const lane of config.discovery.github.lanes) {
    if (!hasSearchBudget(usage, budget)) break;
    for (const query of lane.queries) {
      if (!hasSearchBudget(usage, budget)) break;
      const built = buildLaneSearchQuery(lane, query, options.now);
      if (!built.ok) return built;
      const search = await searchRepositories(options.runGh, built.data, lane.sort, lane.order, lane.perPage);
      usage.apiCallsUsed += 1;
      usage.searchQueriesUsed += 1;
      if (!search.ok) return search;
      for (const item of search.data) {
        const parsed = parseDiscoverySearchItem(item, [`lane:${lane.id}`, `query:${query.id}`]);
        if (!parsed) continue;
        mergeDiscoveryCandidate(byUrl, parsed);
      }
    }
  }

  for (const seed of config.discovery.officialOrganizations) {
    if (!hasSearchBudget(usage, budget)) break;
    const search = await searchRepositories(
      options.runGh,
      buildOrgSeedSearchQuery(seed.github, options.now),
      "updated",
      "desc",
      DISCOVERY_ORG_SEED_PER_PAGE
    );
    usage.apiCallsUsed += 1;
    usage.searchQueriesUsed += 1;
    if (!search.ok) return search;
    for (const item of search.data) {
      const parsed = parseDiscoverySearchItem(item, [`github_org_seed:${seed.github}`]);
      if (!parsed) continue;
      mergeDiscoveryCandidate(byUrl, parsed);
    }
  }

  for (const candidate of byUrl.values()) {
    if (usage.enrichmentsUsed >= budget.maxEnrichments) break;
    if (usage.apiCallsUsed >= budget.apiCallBudget) break;
    if (!needsEnrichment(candidate)) continue;
    const enriched = await enrichRepositoryMetadata(options.runGh, candidate.fullName);
    usage.apiCallsUsed += 1;
    usage.enrichmentsUsed += 1;
    if (!enriched.ok) {
      warnings.push(`enrichment failed for ${candidate.fullName}: ${String(enriched.detail ?? enriched.error)}`);
      continue;
    }
    candidate.createdAt = enriched.data.createdAt;
    candidate.license = enriched.data.license;
    candidate.defaultBranch = enriched.data.defaultBranch;
  }

  const candidates = [...byUrl.values()];
  return ok({
    rateLimit: rateLimit.data,
    apiCallsUsed: usage.apiCallsUsed,
    searchQueriesUsed: usage.searchQueriesUsed,
    enrichmentsUsed: usage.enrichmentsUsed,
    candidates,
    warnings,
    runSummary: {
      candidateCount: candidates.length,
      apiCallsUsed: usage.apiCallsUsed,
      searchQueriesUsed: usage.searchQueriesUsed,
      enrichmentsUsed: usage.enrichmentsUsed,
    },
  });
}

function hasSearchBudget(
  usage: { apiCallsUsed: number; searchQueriesUsed: number },
  budget: { apiCallBudget: number; maxSearchQueries: number }
): boolean {
  return usage.searchQueriesUsed < budget.maxSearchQueries && usage.apiCallsUsed < budget.apiCallBudget;
}

/**
 * Date-window the lane query. A new-release lane may carry an empty query
 * string; the automatically applied date qualifier still yields a valid
 * qualifier-only repository search.
 */
export function buildLaneSearchQuery(lane: GithubLane, query: ResearchQuery, now: Date): Result<string> {
  let built = query.query.trim();
  if (lane.windowDays > 0) {
    const cutoff = new Date(now.getTime() - lane.windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    built = `${built} ${lane.dateField}:>=${cutoff}`.trim();
  }
  if (built === "") {
    return err(
      "DISCOVERY_EMPTY_QUERY",
      `lane ${lane.id} query ${query.id} produced an empty search query; add a date window or query text`
    );
  }
  return ok(built);
}

function buildOrgSeedSearchQuery(org: string, now: Date): string {
  const cutoff = new Date(now.getTime() - DISCOVERY_ORG_SEED_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `org:${org} pushed:>=${cutoff}`;
}

async function searchRepositories(
  runGh: GhRunner,
  query: string,
  sort: string,
  order: string,
  perPage: number
): Promise<Result<SearchRepositoryItem[]>> {
  const result = await ghApi(runGh, [
    "--method",
    "GET",
    GITHUB_REPOSITORY_SEARCH_PATH,
    "-f",
    `q=${query}`,
    "-f",
    `sort=${sort}`,
    "-f",
    `order=${order}`,
    "-f",
    `per_page=${perPage}`,
  ]);
  if (!result.ok) return result;
  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  return ok(Array.isArray(parsed.data.items) ? (parsed.data.items as SearchRepositoryItem[]) : []);
}

/**
 * Enrich through the repository metadata endpoint only, and only when
 * facts the model needs are missing. Never fetches README bodies.
 */
function needsEnrichment(candidate: DiscoveryCandidate): boolean {
  return candidate.createdAt === null || candidate.license === null || candidate.defaultBranch === null;
}

async function enrichRepositoryMetadata(
  runGh: GhRunner,
  fullName: string
): Promise<Result<{ createdAt: string | null; license: string | null; defaultBranch: string | null }>> {
  const result = await ghApi(runGh, [`/repos/${fullName}`]);
  if (!result.ok) return result;
  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  return ok({
    createdAt: typeof parsed.data.created_at === "string" && parsed.data.created_at ? parsed.data.created_at : null,
    license: parseLicense(parsed.data.license),
    defaultBranch:
      typeof parsed.data.default_branch === "string" && parsed.data.default_branch ? parsed.data.default_branch : null,
  });
}

/**
 * Deterministic technical relevance input from repository metadata only.
 * 0..100; the ranker maps it into its bounded relevance component.
 */
export function deriveDiscoveryRelevanceInput(description: string, topics: string[]): number {
  const text = `${description}\n${topics.join(" ")}`.toLowerCase();
  let score = 0;
  if (/\bagent[- ]memory\b/.test(text)) score += 40;
  else if (/\bmemory\b/.test(text)) score += 20;
  if (/\b(claude|codex|mcp|coding agent)\b/.test(text)) score += 20;
  if (/\b(session[- ]continuity|checkpoint|workflow|skill|subagent)\b/.test(text)) score += 15;
  if (/\b(knowledge base|markdown|vault|wiki|sqlite|local[- ]first|sync)\b/.test(text)) score += 15;
  const topicHits = topics.filter((topic) => /agent-memory|memory|mcp|codex|claude/i.test(topic)).length;
  score += Math.min(topicHits * 5, 10);
  return Math.max(0, Math.min(100, score));
}

/**
 * Parse one search result item. Invalid repository items (unparseable or
 * non-canonicalizable URLs, missing identity fields) are skipped, never
 * fatal to the run.
 */
export function parseDiscoverySearchItem(
  item: SearchRepositoryItem,
  sourceIds: string[]
): DiscoveryCandidate | undefined {
  if (typeof item.full_name !== "string" || typeof item.name !== "string" || typeof item.html_url !== "string") {
    return undefined;
  }
  const canonical = canonicalizeDiscoveryRepositoryUrl(item.html_url);
  if (!canonical.ok) return undefined;

  const slash = canonical.data.lastIndexOf("/");
  const owner = canonical.data.slice("https://github.com/".length, slash);
  const name = canonical.data.slice(slash + 1);
  const description = typeof item.description === "string" ? item.description : "";
  const topics = Array.isArray(item.topics)
    ? item.topics.filter((topic): topic is string => typeof topic === "string")
    : [];

  return makeDiscoveryCandidate({
    canonicalUrl: canonical.data,
    fullName: `${owner}/${name}`,
    owner,
    name,
    createdAt: typeof item.created_at === "string" && item.created_at ? item.created_at : null,
    pushedAt: typeof item.pushed_at === "string" && item.pushed_at ? item.pushed_at : null,
    stargazersCount: typeof item.stargazers_count === "number" && Number.isFinite(item.stargazers_count) ? item.stargazers_count : 0,
    forksCount: typeof item.forks_count === "number" && Number.isFinite(item.forks_count) ? item.forks_count : 0,
    archived: typeof item.archived === "boolean" ? item.archived : false,
    topics,
    description,
    license: parseLicense(item.license),
    defaultBranch: typeof item.default_branch === "string" && item.default_branch ? item.default_branch : null,
    sourceIds,
    attentionEvidence: [],
    relevanceInput: deriveDiscoveryRelevanceInput(description, topics),
    evidenceQualityInput: 0,
  });
}

function mergeDiscoveryCandidate(byUrl: Map<string, DiscoveryCandidate>, incoming: DiscoveryCandidate): void {
  const existing = byUrl.get(incoming.canonicalUrl);
  if (!existing) {
    byUrl.set(incoming.canonicalUrl, incoming);
    return;
  }
  existing.sourceIds = uniqueInOrder([...existing.sourceIds, ...incoming.sourceIds]);
  existing.attentionEvidence = mergeAttentionEvidence(existing.attentionEvidence, incoming.attentionEvidence);
  existing.stargazersCount = Math.max(existing.stargazersCount, incoming.stargazersCount);
  existing.forksCount = Math.max(existing.forksCount, incoming.forksCount);
  if (Date.parse(incoming.pushedAt ?? "") > Date.parse(existing.pushedAt ?? "")) existing.pushedAt = incoming.pushedAt;
  if (!existing.createdAt && incoming.createdAt) existing.createdAt = incoming.createdAt;
  if (!existing.description && incoming.description) existing.description = incoming.description;
  existing.topics = uniqueInOrder([...existing.topics, ...incoming.topics]);
  existing.archived = existing.archived && incoming.archived;
  if (!existing.license && incoming.license) existing.license = incoming.license;
  if (!existing.defaultBranch && incoming.defaultBranch) existing.defaultBranch = incoming.defaultBranch;
  existing.relevanceInput = Math.max(existing.relevanceInput, incoming.relevanceInput);
  existing.evidenceQualityInput = Math.max(existing.evidenceQualityInput, incoming.evidenceQualityInput);
}

function mergeAttentionEvidence(
  existing: DiscoveryAttentionEvidence[],
  incoming: DiscoveryAttentionEvidence[]
): DiscoveryAttentionEvidence[] {
  const seen = new Set(existing.map((evidence) => `${evidence.sourceId}|${evidence.url}`));
  const merged = [...existing];
  for (const evidence of incoming) {
    const key = `${evidence.sourceId}|${evidence.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(evidence);
    }
  }
  return merged;
}

function parseLicense(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const spdx = (value as { spdx_id?: unknown }).spdx_id;
  return typeof spdx === "string" && spdx ? spdx : null;
}

async function ghApi(runGh: GhRunner, args: string[]): Promise<Result<GhRunResult>> {
  const result = await runGh(["api", ...args]);
  if (result.exitCode !== 0) return err("GH_API_FAILED", result.stderr || result.stdout);
  return ok(result);
}

function parseRateLimit(text: string): Result<RateLimitState> {
  try {
    const parsed = JSON.parse(text) as RateLimitState;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err("GH_RATE_LIMIT_PARSE_FAILED", "rate_limit response was not an object");
    }
    return ok(parsed);
  } catch (error) {
    return err("GH_RATE_LIMIT_PARSE_FAILED", error instanceof Error ? error.message : String(error));
  }
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

function uniqueInOrder<T>(items: T[]): T[] {
  return [...new Set(items)];
}
