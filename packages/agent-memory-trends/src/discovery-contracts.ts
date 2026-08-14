import type { GithubLane } from "./config.js";

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
