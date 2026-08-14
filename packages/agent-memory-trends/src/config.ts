import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  COMMUNITY_SOURCE_ROLES,
  DISCOVERY_DEFAULT_RETENTION_DAYS,
  DISCOVERY_MAX_API_CALL_BUDGET,
  DISCOVERY_MAX_DAILY_CANDIDATES,
  DISCOVERY_MAX_ENRICHMENTS,
  DISCOVERY_MAX_REPOSITORY_SIGNAL,
  DISCOVERY_MAX_RETENTION_DAYS,
  DISCOVERY_MAX_SEARCH_QUERIES,
  disabledDiscoveryConfig,
  type CommunitySource,
  type DiscoveryConfig,
  type DiscoveryGithubLane,
  type DiscoveryGithubLaneKind,
  type OfficialOrganizationSeed,
} from "./discovery-contracts.js";
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
  version: 1 | 2;
  project: string;
  timezone: string;
  dedupe: {
    digestTtlDays: number;
  };
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
  discovery: DiscoveryConfig;
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
    const version = asNumber(root.version, "version");
    if (version !== 1 && version !== 2) throw new Error("version must be 1 or 2");

    const prefix = version === 2 ? "research_promotion." : "";
    const promotionRoot = version === 2 ? asRecord(root.research_promotion, "research_promotion") : root;
    const scoring = asRecord(promotionRoot.scoring, `${prefix}scoring`);
    const weights = asRecord(scoring.weights, `${prefix}scoring.weights`);
    const github = asRecord(promotionRoot.github, `${prefix}github`);
    const dedupe =
      promotionRoot.dedupe === undefined || promotionRoot.dedupe === null
        ? {}
        : asRecord(promotionRoot.dedupe, `${prefix}dedupe`);
    const watchlist = asRecord(promotionRoot.watchlist, `${prefix}watchlist`);
    const autoAppend = asRecord(watchlist.auto_append, `${prefix}watchlist.auto_append`);

    const laneParse = parseGithubLanes(github, prefix);
    const lanes = laneParse.lanes;
    const queries = lanes.flatMap((lane) => lane.queries);

    const config: ResearchConfig = {
      sourcePath,
      version,
      project: asString(root.project, "project"),
      timezone: asString(root.timezone, "timezone"),
      dedupe: {
        digestTtlDays: asOptionalNonNegativeNumber(dedupe.digest_ttl_days, `${prefix}dedupe.digest_ttl_days`, 14),
      },
      scoring: {
        threshold: asNumber(scoring.threshold, `${prefix}scoring.threshold`),
        weights: parseScoringWeights(weights, prefix),
      },
      github: {
        apiCallBudget: asNumber(github.api_call_budget, `${prefix}github.api_call_budget`),
        maxQueries: asNumber(github.max_queries, `${prefix}github.max_queries`),
        maxRawCandidates: asNumber(github.max_raw_candidates, `${prefix}github.max_raw_candidates`),
        maxSelectedCandidates: asNumber(github.max_selected_candidates, `${prefix}github.max_selected_candidates`),
        lanes,
        queries,
      },
      watchlist: {
        autoAppend: {
          minAppearances: asNumber(autoAppend.min_appearances, `${prefix}watchlist.auto_append.min_appearances`),
          windowDays: asNumber(autoAppend.window_days, `${prefix}watchlist.auto_append.window_days`),
          minScore: asNumber(autoAppend.min_score, `${prefix}watchlist.auto_append.min_score`),
        },
        accepted: parseWatchlistEntries(watchlist.accepted, `${prefix}watchlist.accepted`),
        rejected: parseWatchlistEntries(watchlist.rejected, `${prefix}watchlist.rejected`),
        archived: parseWatchlistEntries(watchlist.archived, `${prefix}watchlist.archived`),
      },
      discovery: version === 2 ? parseDiscoverySection(root) : disabledDiscoveryConfig(),
    };

    const validation = validateResearchConfig(config, laneParse.legacy);
    if (validation) return err("CONFIG_INVALID", validation);
    return ok(config);
  } catch (error) {
    return err("CONFIG_INVALID", getErrorMessage(error));
  }
}

function parseScoringWeights(weights: Record<string, unknown>, prefix: string): ScoringWeights {
  const hasNewKeys =
    weights.implementation_evidence !== undefined ||
    weights.authority_momentum !== undefined ||
    weights.novelty_or_tracking !== undefined;
  if (hasNewKeys) {
    return {
      relevance: asNumber(weights.relevance, `${prefix}scoring.weights.relevance`),
      implementationEvidence: asNumber(weights.implementation_evidence, `${prefix}scoring.weights.implementation_evidence`),
      authorityMomentum: asNumber(weights.authority_momentum, `${prefix}scoring.weights.authority_momentum`),
      freshness: asNumber(weights.freshness, `${prefix}scoring.weights.freshness`),
      noveltyOrTracking: asNumber(weights.novelty_or_tracking, `${prefix}scoring.weights.novelty_or_tracking`),
    };
  }

  return {
    relevance: asNumber(weights.relevance, `${prefix}scoring.weights.relevance`),
    implementationEvidence: asNumber(weights.actionability, `${prefix}scoring.weights.actionability`),
    authorityMomentum: asNumber(weights.authority_activity, `${prefix}scoring.weights.authority_activity`),
    freshness: asNumber(weights.freshness, `${prefix}scoring.weights.freshness`),
    noveltyOrTracking: asNumber(weights.novelty, `${prefix}scoring.weights.novelty`),
  };
}

function parseGithubLanes(github: Record<string, unknown>, prefix: string): { lanes: GithubLane[]; legacy: boolean } {
  if (github.lanes !== undefined) {
    const lanes = asArray(github.lanes, `${prefix}github.lanes`).map((lane, index) =>
      parseGithubLane(lane, `${prefix}github.lanes[${index}]`)
    );
    return { lanes, legacy: false };
  }

  const queries = parseResearchQueries(github.queries, `${prefix}github.queries`);
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

function parseGithubLane(lane: unknown, itemPath: string, allowEmptyQuery = false): GithubLane {
  const item = asRecord(lane, itemPath);
  const queries = parseResearchQueries(item.queries, `${itemPath}.queries`, allowEmptyQuery);
  if (queries.length === 0) throw new Error(`${itemPath}.queries must contain at least one query`);

  return {
    id: asString(item.id, `${itemPath}.id`),
    label: asString(item.label, `${itemPath}.label`),
    windowDays: asNonNegativeNumber(item.window_days, `${itemPath}.window_days`),
    dateField: asEnum(item.date_field, `${itemPath}.date_field`, ["pushed", "created"]),
    sort: asEnum(item.sort, `${itemPath}.sort`, ["updated", "stars"]),
    order: asEnum(item.order, `${itemPath}.order`, ["asc", "desc"]),
    perPage: asPositiveNumber(item.per_page, `${itemPath}.per_page`),
    qualityGate: parseQualityGate(item.quality_gate, `${itemPath}.quality_gate`),
    queries,
  };
}

function parseResearchQueries(value: unknown, path: string, allowEmptyQuery = false): ResearchQuery[] {
  return asArray(value, path).map((query, index) => {
    const item = asRecord(query, `${path}[${index}]`);
    return {
      id: asString(item.id, `${path}[${index}].id`),
      label: asString(item.label, `${path}[${index}].label`),
      query: allowEmptyQuery
        ? asOptionalString(item.query, `${path}[${index}].query`)
        : asString(item.query, `${path}[${index}].query`),
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

function parseDiscoverySection(root: Record<string, unknown>): DiscoveryConfig {
  const discovery = asRecord(root.discovery, "discovery");
  const github = asRecord(discovery.github, "discovery.github");
  const alert = asRecord(discovery.immediate_alert, "discovery.immediate_alert");
  const lanes = parseDiscoveryLanes(github);
  return {
    enabled: asOptionalBoolean(discovery.enabled, "discovery.enabled", true),
    maxDailyCandidates: asPositiveInteger(discovery.max_daily_candidates, "discovery.max_daily_candidates"),
    retentionDays: asOptionalPositiveInteger(
      discovery.retention_days,
      "discovery.retention_days",
      DISCOVERY_DEFAULT_RETENTION_DAYS
    ),
    immediateAlert: {
      enabled: asBoolean(alert.enabled, "discovery.immediate_alert.enabled"),
      minRepositorySignal: asNonNegativeInteger(
        alert.min_repository_signal,
        "discovery.immediate_alert.min_repository_signal"
      ),
      minIndependentSignalCount: asPositiveInteger(
        alert.min_independent_signal_count,
        "discovery.immediate_alert.min_independent_signal_count"
      ),
    },
    github: {
      apiCallBudget: asPositiveInteger(github.api_call_budget, "discovery.github.api_call_budget"),
      maxSearchQueries: asPositiveInteger(github.max_search_queries, "discovery.github.max_search_queries"),
      maxEnrichments: asPositiveInteger(github.max_enrichments, "discovery.github.max_enrichments"),
      lanes,
    },
    officialOrganizations: parseOfficialOrganizations(
      discovery.official_organizations,
      "discovery.official_organizations"
    ),
    communitySources: parseCommunitySources(discovery.community_sources, "discovery.community_sources"),
  };
}

function parseDiscoveryLanes(github: Record<string, unknown>): DiscoveryGithubLane[] {
  const laneGroups: Array<[string, DiscoveryGithubLaneKind]> = [
    ["new_release_lanes", "new_release"],
    ["relevance_lanes", "relevance"],
    ["topic_lanes", "topic"],
  ];
  const lanes: DiscoveryGithubLane[] = [];
  for (const [key, kind] of laneGroups) {
    if (github[key] === undefined || github[key] === null) continue;
    asArray(github[key], `discovery.github.${key}`).forEach((lane, index) => {
      // New-release lanes may carry an empty query string: the collector
      // turns it into a qualifier-only repository search with the date window.
      lanes.push({ ...parseGithubLane(lane, `discovery.github.${key}[${index}]`, kind === "new_release"), kind });
    });
  }
  return lanes;
}

function parseOfficialOrganizations(value: unknown, path: string): OfficialOrganizationSeed[] {
  if (value === undefined || value === null) return [];
  return asArray(value, path).map((seed, index) => {
    const item = asRecord(seed, `${path}[${index}]`);
    const github = asString(item.github, `${path}[${index}].github`).trim();
    if (!isValidGithubOrganizationIdentifier(github)) {
      throw new Error(`${path}[${index}].github must be a valid GitHub organization identifier`);
    }
    const officialUrls = asArray(item.official_urls, `${path}[${index}].official_urls`).map((url, urlIndex) => {
      const value = asString(url, `${path}[${index}].official_urls[${urlIndex}]`);
      if (!/^https:\/\//i.test(value)) {
        throw new Error(`${path}[${index}].official_urls[${urlIndex}] must be an https URL`);
      }
      return value;
    });
    if (officialUrls.length === 0) {
      throw new Error(`${path}[${index}].official_urls must contain at least one URL`);
    }
    return {
      github: github.toLowerCase(),
      region: asString(item.region, `${path}[${index}].region`),
      officialUrls,
      categories: asArray(item.categories, `${path}[${index}].categories`).map((category, categoryIndex) =>
        asString(category, `${path}[${index}].categories[${categoryIndex}]`)
      ),
    };
  });
}

function parseCommunitySources(value: unknown, path: string): CommunitySource[] {
  if (value === undefined || value === null) return [];
  return asArray(value, path).map((source, index) => {
    const item = asRecord(source, `${path}[${index}]`);
    return {
      id: asString(item.id, `${path}[${index}].id`),
      enabled: asBoolean(item.enabled, `${path}[${index}].enabled`),
      role: asEnum(item.role, `${path}[${index}].role`, COMMUNITY_SOURCE_ROLES),
    };
  });
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
  if (config.version !== 1 && config.version !== 2) return "version must be 1 or 2";
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

  if (config.version === 2) {
    const discovery = config.discovery;
    if (discovery.maxDailyCandidates > DISCOVERY_MAX_DAILY_CANDIDATES) {
      return `discovery.max_daily_candidates must be <= ${DISCOVERY_MAX_DAILY_CANDIDATES}`;
    }
    if (discovery.retentionDays > DISCOVERY_MAX_RETENTION_DAYS) {
      return `discovery.retention_days must be <= ${DISCOVERY_MAX_RETENTION_DAYS}`;
    }
    if (discovery.github.apiCallBudget > DISCOVERY_MAX_API_CALL_BUDGET) {
      return `discovery.github.api_call_budget must be <= ${DISCOVERY_MAX_API_CALL_BUDGET}`;
    }
    if (discovery.github.maxSearchQueries > DISCOVERY_MAX_SEARCH_QUERIES) {
      return `discovery.github.max_search_queries must be <= ${DISCOVERY_MAX_SEARCH_QUERIES}`;
    }
    if (discovery.github.maxEnrichments > DISCOVERY_MAX_ENRICHMENTS) {
      return `discovery.github.max_enrichments must be <= ${DISCOVERY_MAX_ENRICHMENTS}`;
    }
    if (discovery.github.lanes.some((lane) => lane.perPage > 100)) {
      return "discovery.github lanes per_page must be <= 100";
    }
    if (discovery.immediateAlert.minRepositorySignal > DISCOVERY_MAX_REPOSITORY_SIGNAL) {
      return `discovery.immediate_alert.min_repository_signal must be <= ${DISCOVERY_MAX_REPOSITORY_SIGNAL}`;
    }
    if (discovery.github.lanes.length === 0) return "discovery.github lanes must contain at least one lane";
    if (
      discovery.github.lanes.some(
        (lane) => lane.kind === "new_release" && lane.windowDays === 0 && lane.queries.some((query) => query.query === "")
      )
    ) {
      return "new_release lanes with a blank query require a positive window_days";
    }
    const discoveryLaneIds = discovery.github.lanes.map((lane) => lane.id);
    if (new Set(discoveryLaneIds).size !== discoveryLaneIds.length) {
      return "discovery.github lanes ids must be unique";
    }
    const discoveryQueryIds = discovery.github.lanes.flatMap((lane) => lane.queries).map((query) => query.id);
    if (new Set(discoveryQueryIds).size !== discoveryQueryIds.length) {
      return "discovery.github query ids must be unique across lanes";
    }
    const orgIds = discovery.officialOrganizations.map((org) => org.github);
    if (new Set(orgIds).size !== orgIds.length) {
      return "discovery.official_organizations github identifiers must be unique";
    }
    const sourceIds = discovery.communitySources.map((source) => source.id);
    if (new Set(sourceIds).size !== sourceIds.length) {
      return "discovery.community_sources ids must be unique";
    }
  }
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

function asOptionalString(value: unknown, path: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value.trim();
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

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function asInteger(value: unknown, path: string): number {
  const number = asNumber(value, path);
  if (!Number.isInteger(number)) throw new Error(`${path} must be an integer`);
  return number;
}

function asNonNegativeInteger(value: unknown, path: string): number {
  const number = asInteger(value, path);
  if (number < 0) throw new Error(`${path} must be >= 0`);
  return number;
}

function asPositiveInteger(value: unknown, path: string): number {
  const number = asInteger(value, path);
  if (number <= 0) throw new Error(`${path} must be > 0`);
  return number;
}

function asOptionalPositiveInteger(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return asPositiveInteger(value, path);
}

function isValidGithubOrganizationIdentifier(id: string): boolean {
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(id) && !id.includes("--");
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
