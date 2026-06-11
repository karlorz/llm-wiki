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
  actionability: number;
  authorityActivity: number;
  freshness: number;
  novelty: number;
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

    const queries = asArray(github.queries, "github.queries").map((query, index) => {
      const item = asRecord(query, `github.queries[${index}]`);
      return {
        id: asString(item.id, `github.queries[${index}].id`),
        label: asString(item.label, `github.queries[${index}].label`),
        query: asString(item.query, `github.queries[${index}].query`),
      };
    });

    const config: ResearchConfig = {
      sourcePath,
      version: asNumber(root.version, "version") as 1,
      project: asString(root.project, "project"),
      timezone: asString(root.timezone, "timezone"),
      scoring: {
        threshold: asNumber(scoring.threshold, "scoring.threshold"),
        weights: {
          relevance: asNumber(weights.relevance, "scoring.weights.relevance"),
          actionability: asNumber(weights.actionability, "scoring.weights.actionability"),
          authorityActivity: asNumber(weights.authority_activity, "scoring.weights.authority_activity"),
          freshness: asNumber(weights.freshness, "scoring.weights.freshness"),
          novelty: asNumber(weights.novelty, "scoring.weights.novelty"),
        },
      },
      github: {
        apiCallBudget: asNumber(github.api_call_budget, "github.api_call_budget"),
        maxQueries: asNumber(github.max_queries, "github.max_queries"),
        maxRawCandidates: asNumber(github.max_raw_candidates, "github.max_raw_candidates"),
        maxSelectedCandidates: asNumber(github.max_selected_candidates, "github.max_selected_candidates"),
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

    const validation = validateResearchConfig(config);
    if (validation) return err("CONFIG_INVALID", validation);
    return ok(config);
  } catch (error) {
    return err("CONFIG_INVALID", getErrorMessage(error));
  }
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

function validateResearchConfig(config: ResearchConfig): string | undefined {
  if (config.version !== 1) return "version must be 1";
  if (config.github.maxQueries > 10) return "github.max_queries must be <= 10";
  if (config.github.maxRawCandidates > 50) return "github.max_raw_candidates must be <= 50";
  if (config.github.maxSelectedCandidates > 10) return "github.max_selected_candidates must be <= 10";
  if (config.github.apiCallBudget > 100) return "github.api_call_budget must be <= 100";
  if (config.github.queries.length !== 10) return "github.queries must contain the accepted 10-query portfolio";
  if (config.github.queries.length > config.github.maxQueries) return "github.queries exceeds github.max_queries";

  const ids = config.github.queries.map((query) => query.id);
  if (ids.join(",") !== REQUIRED_QUERY_IDS.join(",")) {
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
