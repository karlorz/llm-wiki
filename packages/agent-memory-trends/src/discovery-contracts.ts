import type { GithubLane } from "./config.js";
import { err, ok, type Result } from "./types.js";

/**
 * Shared discovery data contracts for the recall-first discovery ladder.
 * Pure types and constants only; parsing/validation lives in config.ts.
 */

export type CommunitySourceRole = "discovery" | "corroboration";
export type DiscoveryGithubLaneKind = "new_release" | "relevance" | "topic";

export const COMMUNITY_SOURCE_ROLES: readonly CommunitySourceRole[] = ["discovery", "corroboration"];
export const DISCOVERY_LANE_KINDS: readonly DiscoveryGithubLaneKind[] = ["new_release", "relevance", "topic"];

export const DISCOVERY_MAX_DAILY_CANDIDATES = 20;
export const DISCOVERY_DEFAULT_RETENTION_DAYS = 30;
export const DISCOVERY_MAX_RETENTION_DAYS = 90;
export const DISCOVERY_MAX_API_CALL_BUDGET = 100;
export const DISCOVERY_MAX_SEARCH_QUERIES = 100;
export const DISCOVERY_MAX_ENRICHMENTS = 100;
/** Maximum reachable repository signal: momentum 0..40 + official identity 0..15. */
export const DISCOVERY_MAX_REPOSITORY_SIGNAL = 55;

/** Maximum community items normalized per community source per run. */
export const COMMUNITY_MAX_ITEMS_PER_SOURCE = 20;
/** Maximum fetch calls a community source may make per run. */
export const COMMUNITY_MAX_FETCHES_PER_SOURCE = 10;

/** Maximum attention evidence references kept per candidate. */
export const DISCOVERY_ATTENTION_EVIDENCE_MAX = 20;
/** Maximum length of an attention evidence excerpt/title reference. */
export const DISCOVERY_ATTENTION_EXCERPT_MAX = 200;

/**
 * Discovery queue dispositions. These describe what the ranked discovery
 * queue does with a candidate; none of them implies task/bug/idea capture
 * creation or automatic work of any kind.
 */
export type DiscoveryDisposition = "new" | "watch" | "alert" | "tracked" | "suppressed";

export const DISCOVERY_DISPOSITIONS: readonly DiscoveryDisposition[] = [
  "new",
  "watch",
  "alert",
  "tracked",
  "suppressed",
];

/**
 * Bounded public attention evidence reference. `excerpt`/`title`/
 * `englishSummary` are capped to DISCOVERY_ATTENTION_EXCERPT_MAX by
 * producers; never a full page body.
 */
export interface DiscoveryAttentionEvidence {
  sourceId: string;
  url: string;
  language?: string;
  title?: string;
  excerpt?: string;
  /** Bounded English review summary; optional and backwards-compatible. */
  englishSummary?: string;
}

/**
 * Compact normalized public community observation reference. One reference
 * per canonical repository URL per observation. All retained text fields
 * are capped to DISCOVERY_ATTENTION_EXCERPT_MAX by producers; never a full
 * page body, README body, request header, prompt, environment value,
 * secret, token, or credential.
 */
export interface CommunityReference {
  /** Strict canonical GitHub repository URL; the only repository identity form. */
  canonicalUrl: string;
  /** Configured community source ID that produced this reference. */
  sourceId: string;
  /** Public URL of the observation itself (story/item/entry page). */
  sourceUrl: string;
  /** Original-language metadata where supplied. */
  language?: string;
  title?: string;
  excerpt?: string;
  /**
   * Deterministic bounded English review summary. Conservative generic
   * description when no source-provided English summary exists; never a
   * translation and never inferred claims.
   */
  englishSummary: string;
  /** Observation timestamp (ISO 8601) where valid. */
  observedAt?: string;
}

export interface DiscoveryScoreComponents {
  /** Repository momentum: stars, forks, push freshness, 24h star delta. 0..40 */
  momentum: number;
  /** Official organization identity: seed match plus org-seed provenance. 0..15 */
  officialIdentity: number;
  /** Independent non-GitHub corroboration sources. 0..20 */
  corroboration: number;
  /** Technical relevance input mapped to the bounded component. 0..15 */
  relevance: number;
  /** Evidence quality input mapped to the bounded component. 0..10 */
  evidenceQuality: number;
}

export interface DiscoveryScore {
  /** Total of all bounded components. 0..100 */
  total: number;
  /** Repository/official-identity signal: momentum + officialIdentity. 0..55 */
  repositorySignal: number;
  components: DiscoveryScoreComponents;
}

/**
 * Canonical discovery candidate. The classification/status (disposition)
 * cannot imply automatic task/capture creation: the model carries no
 * capture kind and no promotion instruction.
 */
export interface DiscoveryCandidate {
  /** Canonical repository identity, lowercase, no trailing slash. */
  canonicalUrl: string;
  fullName: string;
  owner: string;
  name: string;
  /** ISO timestamps; null when unknown. */
  createdAt: string | null;
  pushedAt: string | null;
  stargazersCount: number;
  forksCount: number;
  archived: boolean;
  topics: string[];
  description: string;
  license: string | null;
  defaultBranch: string | null;
  /**
   * Ordered, deduplicated discovery provenance source IDs. GitHub-derived
   * markers use `lane:<laneId>`, `query:<queryId>`, `github_org_seed:<org>`.
   */
  sourceIds: string[];
  attentionEvidence: DiscoveryAttentionEvidence[];
  /** Technical relevance input, 0..100. */
  relevanceInput: number;
  /** Evidence quality input, 0..100. */
  evidenceQualityInput: number;
  /**
   * Star/fork deltas against prior observations for the same canonical URL.
   * null means baseline unknown (first observation), never numeric zero.
   */
  starDelta24h: number | null;
  starDelta7d: number | null;
  forkDelta24h: number | null;
  forkDelta7d: number | null;
  /** Ranked queue disposition; collector default is a pre-ranking placeholder. */
  disposition: DiscoveryDisposition;
  alert: boolean;
  /** False for tracked candidates: not eligible for automatic research promotion. */
  promotionEligible: boolean;
  /** Explainable bounded score components filled by the ranker. */
  score: DiscoveryScore;
  /** Deterministic explanatory reason strings. */
  reasons: string[];
}

export interface DiscoveryCandidateFacts {
  canonicalUrl: string;
  fullName: string;
  owner: string;
  name: string;
  createdAt: string | null;
  pushedAt: string | null;
  stargazersCount: number;
  forksCount: number;
  archived: boolean;
  topics: string[];
  description: string;
  license: string | null;
  defaultBranch: string | null;
  sourceIds: string[];
  attentionEvidence: DiscoveryAttentionEvidence[];
  relevanceInput: number;
  evidenceQualityInput: number;
}

export interface DiscoverySnapshot {
  formatVersion: 1;
  runAt: string;
  retentionDays: number;
  candidates: DiscoveryCandidate[];
}

export interface ImmediateAlertConfig {
  enabled: boolean;
  minRepositorySignal: number;
  minIndependentSignalCount: number;
}

export interface GithubDiscoveryBudget {
  apiCallBudget: number;
  maxSearchQueries: number;
  maxEnrichments: number;
}

export interface DiscoveryGithubLane extends GithubLane {
  kind: DiscoveryGithubLaneKind;
}

export interface GithubDiscoveryConfig extends GithubDiscoveryBudget {
  lanes: DiscoveryGithubLane[];
}

export interface OfficialOrganizationSeed {
  github: string;
  region: string;
  officialUrls: string[];
  categories: string[];
}

export interface CommunitySource {
  id: string;
  enabled: boolean;
  role: CommunitySourceRole;
}

export interface DiscoveryConfig {
  enabled: boolean;
  maxDailyCandidates: number;
  retentionDays: number;
  immediateAlert: ImmediateAlertConfig;
  github: GithubDiscoveryConfig;
  officialOrganizations: OfficialOrganizationSeed[];
  communitySources: CommunitySource[];
}

/** Discovery configuration for v1 documents: present but inert. */
export function disabledDiscoveryConfig(): DiscoveryConfig {
  return {
    enabled: false,
    maxDailyCandidates: 0,
    retentionDays: 0,
    immediateAlert: {
      enabled: false,
      minRepositorySignal: 0,
      minIndependentSignalCount: 1,
    },
    github: { apiCallBudget: 0, maxSearchQueries: 0, maxEnrichments: 0, lanes: [] },
    officialOrganizations: [],
    communitySources: [],
  };
}

const GITHUB_REPOSITORY_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i;
const GITHUB_SEGMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * Canonicalize a GitHub repository URL. Accepts only
 * `https://github.com/<owner>/<repo>` (optionally with a trailing slash),
 * lowercases owner/repo, and rejects every non-repository or non-GitHub URL.
 * This is discovery-scoped canonicalization; vault dedupe behavior is not
 * generalized here.
 */
export function canonicalizeDiscoveryRepositoryUrl(url: string): Result<string> {
  const trimmed = url.trim().replace(/\/+$/, "");
  const match = trimmed.match(GITHUB_REPOSITORY_URL);
  if (!match) {
    return err("DISCOVERY_INVALID_REPOSITORY_URL", `expected https://github.com/<owner>/<repo>, got: ${url.trim()}`);
  }
  const owner = match[1]!.toLowerCase();
  const repo = match[2]!.toLowerCase();
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
    return err("DISCOVERY_INVALID_REPOSITORY_URL", `invalid owner or repository segment in: ${url.trim()}`);
  }
  return ok(`https://github.com/${owner}/${repo}`);
}

/** Blank score used by collectors before the ranker fills it in. */
export function blankDiscoveryScore(): DiscoveryScore {
  return {
    total: 0,
    repositorySignal: 0,
    components: { momentum: 0, officialIdentity: 0, corroboration: 0, relevance: 0, evidenceQuality: 0 },
  };
}

/**
 * Build a canonical discovery candidate from collected facts with
 * pre-ranking defaults: null deltas, blank score, disposition placeholder
 * "new", no alert, not promotion-eligible until the ranker decides.
 */
export function makeDiscoveryCandidate(facts: DiscoveryCandidateFacts): DiscoveryCandidate {
  return {
    canonicalUrl: facts.canonicalUrl,
    fullName: facts.fullName,
    owner: facts.owner,
    name: facts.name,
    createdAt: facts.createdAt,
    pushedAt: facts.pushedAt,
    stargazersCount: facts.stargazersCount,
    forksCount: facts.forksCount,
    archived: facts.archived,
    topics: facts.topics,
    description: facts.description,
    license: facts.license,
    defaultBranch: facts.defaultBranch,
    sourceIds: facts.sourceIds,
    attentionEvidence: facts.attentionEvidence,
    relevanceInput: facts.relevanceInput,
    evidenceQualityInput: facts.evidenceQualityInput,
    starDelta24h: null,
    starDelta7d: null,
    forkDelta24h: null,
    forkDelta7d: null,
    disposition: "new",
    alert: false,
    promotionEligible: false,
    reasons: [],
    score: blankDiscoveryScore(),
  };
}
