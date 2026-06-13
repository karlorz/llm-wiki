import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { err, ok, type Result } from "./types.js";

export interface ResearchQuery {
  id: string;
  label: string;
  query: string;
}

export interface ScoringWeights {
  relevance: number;
  implementationEvidence: number;
  authorityMomentum: number;
  freshness: number;
  noveltyOrTracking: number;
}

export type GithubLaneSort = "updated" | "stars";
export type GithubLaneOrder = "asc" | "desc";
export type GithubDateField = "pushed" | "created";

export interface GithubQualityGate {
  minStars: number;
  minForks: number;
  minEvidenceFamilies: number;
  allowMultiQueryException: boolean;
  allowStrongEvidenceException: boolean;
}

export interface GithubLane {
  id: string;
  label: string;
  windowDays: number;
  dateField: GithubDateField;
  sort: GithubLaneSort;
  order: GithubLaneOrder;
  perPage: number;
  qualityGate: GithubQualityGate;
  queries: ResearchQuery[];
}

export interface WatchlistEntry {
  canonicalUrl: string;
  reason: string;
}

export interface ResearchConfig {
  sourcePath: string;
  version: 1;
  project: string;
  timezone: string;
  scoring: {
    threshold: number;
    weights: ScoringWeights;
  };
  github: {
    apiCallBudget: number;
    maxQueries: number;
    maxRawCandidates: number;
    maxSelectedCandidates: number;
    lanes: GithubLane[];
    queries: ResearchQuery[];
  };
  watchlist: {
    autoAppend: {
      minAppearances: number;
      windowDays: number;
      minScore: number;
    };
    accepted: WatchlistEntry[];
    rejected: WatchlistEntry[];
    archived: WatchlistEntry[];
  };
}

export interface WatchlistAppearance {
  seenAt: string;
  score: number;
  canonicalUrl: string;
}

export interface WatchlistDecisionInput {
  candidate: {
    canonicalUrl: string;
    name: string;
  };
  appearances: WatchlistAppearance[];
  config: ResearchConfig;
  now: Date;
}

export interface WatchlistDecision {
  shouldAppend: boolean;
  reason: string;
}

const REQUIRED_QUERY_IDS = [
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
];

const MAX_GITHUB_QUERIES = 24;

export function readResearchConfig(path: string): Result<ResearchConfig> {
  return parseResearchConfig(readFileSync(path, "utf8"), path);
}

export function parseResearchConfig(text: string, sourcePath: string): Result<ResearchConfig> {
  let raw: unknown;
  try {
    raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return err("CONFIG_INVALID", `invalid YAML in ${sourcePath}: ${getErrorMessage(error)}`);
  }

  try {
    const root = asRecord(raw, "root");
    const scoring = asRecord(root.scoring, "scoring");
    const weights = asRecord(scoring.weights, "scoring.weights");
    const github = asRecord(root.github, "github");
    const watchlist = asRecord(root.watchlist, "watchlist");
    const autoAppend = asRecord(watchlist.auto_append, "watchlist.auto_append");

    const laneParse = parseGithubLanes(github);
    const lanes = laneParse.lanes;
    const queries = lanes.flatMap((lane) => lane.queries);

    const config: ResearchConfig = {
      sourcePath,
      version: asNumber(root.version, "version") as 1,
      project: asString(root.project, "project"),
      timezone: asString(root.timezone, "timezone"),
      scoring: {
        threshold: asNumber(scoring.threshold, "scoring.threshold"),
        weights: parseScoringWeights(weights),
      },
      github: {
        apiCallBudget: asNumber(github.api_call_budget, "github.api_call_budget"),
        maxQueries: asNumber(github.max_queries, "github.max_queries"),
        maxRawCandidates: asNumber(github.max_raw_candidates, "github.max_raw_candidates"),
        maxSelectedCandidates: asNumber(github.max_selected_candidates, "github.max_selected_candidates"),
        lanes,
        queries,
      },
      watchlist: {
        autoAppend: {
          minAppearances: asNumber(autoAppend.min_appearances, "watchlist.auto_append.min_appearances"),
          windowDays: asNumber(autoAppend.window_days, "watchlist.auto_append.window_days"),
          minScore: asNumber(autoAppend.min_score, "watchlist.auto_append.min_score"),
        },
        accepted: parseWatchlistEntries(watchlist.accepted, "watchlist.accepted"),
        rejected: parseWatchlistEntries(watchlist.rejected, "watchlist.rejected"),
        archived: parseWatchlistEntries(watchlist.archived, "watchlist.archived"),
      },
    };

    const validation = validateResearchConfig(config, laneParse.legacy);
    if (validation) return err("CONFIG_INVALID", validation);
    return ok(config);
  } catch (error) {
    return err("CONFIG_INVALID", getErrorMessage(error));
  }
}

function parseScoringWeights(weights: Record<string, unknown>): ScoringWeights {
  const hasNewKeys =
    weights.implementation_evidence !== undefined ||
    weights.authority_momentum !== undefined ||
    weights.novelty_or_tracking !== undefined;
  if (hasNewKeys) {
    return {
      relevance: asNumber(weights.relevance, "scoring.weights.relevance"),
      implementationEvidence: asNumber(weights.implementation_evidence, "scoring.weights.implementation_evidence"),
      authorityMomentum: asNumber(weights.authority_momentum, "scoring.weights.authority_momentum"),
      freshness: asNumber(weights.freshness, "scoring.weights.freshness"),
      noveltyOrTracking: asNumber(weights.novelty_or_tracking, "scoring.weights.novelty_or_tracking"),
    };
  }

  return {
    relevance: asNumber(weights.relevance, "scoring.weights.relevance"),
    implementationEvidence: asNumber(weights.actionability, "scoring.weights.actionability"),
    authorityMomentum: asNumber(weights.authority_activity, "scoring.weights.authority_activity"),
    freshness: asNumber(weights.freshness, "scoring.weights.freshness"),
    noveltyOrTracking: asNumber(weights.novelty, "scoring.weights.novelty"),
  };
}

function parseGithubLanes(github: Record<string, unknown>): { lanes: GithubLane[]; legacy: boolean } {
  if (github.lanes !== undefined) {
    const lanes = asArray(github.lanes, "github.lanes").map(parseGithubLane);
    return { lanes, legacy: false };
  }

  const queries = parseResearchQueries(github.queries, "github.queries");
  return {
    legacy: true,
    lanes: [
      {
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
          allowMultiQueryException: false,
          allowStrongEvidenceException: false,
        },
        queries,
      },
    ],
  };
}

function parseGithubLane(lane: unknown, index: number): GithubLane {
  const path = `github.lanes[${index}]`;
  const item = asRecord(lane, path);
  const queries = parseResearchQueries(item.queries, `${path}.queries`);
  if (queries.length === 0) throw new Error(`${path}.queries must contain at least one query`);

  return {
    id: asString(item.id, `${path}.id`),
    label: asString(item.label, `${path}.label`),
    windowDays: asNonNegativeNumber(item.window_days, `${path}.window_days`),
    dateField: asEnum(item.date_field, `${path}.date_field`, ["pushed", "created"]),
    sort: asEnum(item.sort, `${path}.sort`, ["updated", "stars"]),
    order: asEnum(item.order, `${path}.order`, ["asc", "desc"]),
    perPage: asPositiveNumber(item.per_page, `${path}.per_page`),
    qualityGate: parseQualityGate(item.quality_gate, `${path}.quality_gate`),
    queries,
  };
}

function parseResearchQueries(value: unknown, path: string): ResearchQuery[] {
  return asArray(value, path).map((query, index) => {
    const item = asRecord(query, `${path}[${index}]`);
    return {
      id: asString(item.id, `${path}[${index}].id`),
      label: asString(item.label, `${path}[${index}].label`),
      query: asString(item.query, `${path}[${index}].query`),
    };
  });
}

function parseQualityGate(value: unknown, path: string): GithubQualityGate {
  const item = value === undefined || value === null ? {} : asRecord(value, path);
  return {
    minStars: asOptionalNonNegativeNumber(item.min_stars, `${path}.min_stars`, 0),
    minForks: asOptionalNonNegativeNumber(item.min_forks, `${path}.min_forks`, 0),
    minEvidenceFamilies: asOptionalNonNegativeNumber(item.min_evidence_families, `${path}.min_evidence_families`, 1),
    allowMultiQueryException: asOptionalBoolean(item.allow_multi_query_exception, `${path}.allow_multi_query_exception`, false),
    allowStrongEvidenceException: asOptionalBoolean(item.allow_strong_evidence_exception, `${path}.allow_strong_evidence_exception`, false),
  };
}

export function shouldAutoAppendWatchlist(input: WatchlistDecisionInput): WatchlistDecision {
  const candidateUrl = normalizeCanonicalUrl(input.candidate.canonicalUrl);
  if (hasWatchlistUrl(input.config.watchlist.accepted, candidateUrl)) {
    return { shouldAppend: false, reason: `${input.candidate.name} is already accepted` };
  }
  if (hasWatchlistUrl(input.config.watchlist.rejected, candidateUrl)) {
    return { shouldAppend: false, reason: `${input.candidate.name} is rejected` };
  }
  if (hasWatchlistUrl(input.config.watchlist.archived, candidateUrl)) {
    return { shouldAppend: false, reason: `${input.candidate.name} is archived` };
  }

  const windowMs = input.config.watchlist.autoAppend.windowDays * 24 * 60 * 60 * 1000;
  const earliest = input.now.getTime() - windowMs;
  const inWindow = input.appearances.filter((appearance) => {
    const seenAt = Date.parse(appearance.seenAt);
    return Number.isFinite(seenAt) && seenAt >= earliest && seenAt <= input.now.getTime();
  });

  if (inWindow.length < input.config.watchlist.autoAppend.minAppearances) {
    return {
      shouldAppend: false,
      reason: `needs ${input.config.watchlist.autoAppend.minAppearances} appearances in ${input.config.watchlist.autoAppend.windowDays} days`,
    };
  }

  if (inWindow.some((appearance) => normalizeCanonicalUrl(appearance.canonicalUrl) !== candidateUrl)) {
    return { shouldAppend: false, reason: "appearances do not have a stable canonical URL" };
  }

  if (inWindow.some((appearance) => appearance.score < input.config.watchlist.autoAppend.minScore)) {
    return {
      shouldAppend: false,
      reason: `all appearances must score at least ${input.config.watchlist.autoAppend.minScore}`,
    };
  }

  return {
    shouldAppend: true,
    reason: `${inWindow.length} appearances in ${input.config.watchlist.autoAppend.windowDays} days above score ${input.config.watchlist.autoAppend.minScore}; stable canonical URL ${candidateUrl}`,
  };
}

export function normalizeCanonicalUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (!match) return trimmed;
  return `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

function validateResearchConfig(config: ResearchConfig, legacyQueries: boolean): string | undefined {
  if (config.version !== 1) return "version must be 1";
  if (config.github.maxQueries > MAX_GITHUB_QUERIES) return `github.max_queries must be <= ${MAX_GITHUB_QUERIES}`;
  if (config.github.maxRawCandidates > 50) return "github.max_raw_candidates must be <= 50";
  if (config.github.maxSelectedCandidates > 10) return "github.max_selected_candidates must be <= 10";
  if (config.github.apiCallBudget > 100) return "github.api_call_budget must be <= 100";
  if (config.github.lanes.length === 0) return "github.lanes must contain at least one lane";
  if (config.github.queries.length > config.github.maxQueries) return "github lane queries exceed github.max_queries";
  if (config.github.lanes.some((lane) => lane.perPage > 100)) return "github.lanes per_page must be <= 100";

  const laneIds = config.github.lanes.map((lane) => lane.id);
  if (new Set(laneIds).size !== laneIds.length) return "github.lanes ids must be unique";
  const queryIds = config.github.queries.map((query) => query.id);
  if (new Set(queryIds).size !== queryIds.length) return "github query ids must be unique across lanes";

  if (legacyQueries && config.github.queries.length !== 10) return "github.queries must contain the accepted 10-query portfolio";

  if (legacyQueries && queryIds.join(",") !== REQUIRED_QUERY_IDS.join(",")) {
    return `github.queries ids must match accepted portfolio: ${REQUIRED_QUERY_IDS.join(", ")}`;
  }

  const weightSum = Object.values(config.scoring.weights).reduce((sum, value) => sum + value, 0);
  if (weightSum !== 100) return "scoring.weights must sum to 100";
  if (config.watchlist.autoAppend.minAppearances < 3) return "watchlist.auto_append.min_appearances must be >= 3";
  return undefined;
}

function parseWatchlistEntries(value: unknown, path: string): WatchlistEntry[] {
  if (value === undefined || value === null) return [];
  return asArray(value, path).map((entry, index) => {
    const item = asRecord(entry, `${path}[${index}]`);
    return {
      canonicalUrl: normalizeCanonicalUrl(asString(item.canonical_url, `${path}[${index}].canonical_url`)),
      reason: asString(item.reason, `${path}[${index}].reason`),
    };
  });
}

function hasWatchlistUrl(entries: WatchlistEntry[], canonicalUrl: string): boolean {
  return entries.some((entry) => entry.canonicalUrl === canonicalUrl);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function asNonNegativeNumber(value: unknown, path: string): number {
  const number = asNumber(value, path);
  if (number < 0) throw new Error(`${path} must be >= 0`);
  return number;
}

function asPositiveNumber(value: unknown, path: string): number {
  const number = asNumber(value, path);
  if (number <= 0) throw new Error(`${path} must be > 0`);
  return number;
}

function asOptionalNonNegativeNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return asNonNegativeNumber(value, path);
}

function asOptionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
