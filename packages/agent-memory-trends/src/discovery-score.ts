import type { ResearchConfig } from "./config.js";
import type { DiscoveryCandidate, DiscoveryDisposition, DiscoveryScoreComponents } from "./discovery-contracts.js";

/**
 * Pure deterministic ranker and queue builder for the recall-first
 * discovery ladder. Scores repository momentum, official identity,
 * independent/community corroboration count, technical relevance input, and
 * evidence quality input with explicit bounded components and explanatory
 * reason strings. Emits only discovery dispositions; no capture kind, no
 * synthesis output, no automatic work creation.
 */

/** Tracked candidates need fresh momentum (recent push) to stay in the queue. */
const DISCOVERY_TRACKED_FRESH_DAYS = 30;
/** Total score below this floor is suppressed from the queue. */
const DISCOVERY_QUEUE_MIN_SCORE = 25;
/** Repository signal at or above this marks a disposition of "new". */
const DISCOVERY_NEW_SIGNAL_FLOOR = 20;
/** Corroboration sources above this count add no further score. */
const DISCOVERY_CORROBORATION_CAP = 4;

export interface DiscoveryRankContext {
  config: ResearchConfig;
  now: Date;
  /** Canonical repository URLs already observed in discovery history. */
  trackedUrls: string[];
}

export interface IndependentSignals {
  count: number;
  sourceIds: string[];
}

export interface DiscoveryQueue {
  generatedAt: string;
  /** Ranked, capped at config.discovery.maxDailyCandidates. */
  candidates: DiscoveryCandidate[];
  counts: {
    totalEvaluated: number;
    queued: number;
    suppressed: number;
    alert: number;
    tracked: number;
    new: number;
    watch: number;
  };
}

/**
 * Score and classify one candidate. Returns a new candidate object with
 * score, alert flag, promotion eligibility, disposition, and reasons filled.
 */
export function evaluateDiscoveryCandidate(
  candidate: DiscoveryCandidate,
  context: DiscoveryRankContext
): DiscoveryCandidate {
  const components = scoreComponents(candidate, context);
  const total = clamp(components.momentum + components.officialIdentity + components.corroboration + components.relevance + components.evidenceQuality, 0, 100);
  const repositorySignal = components.momentum + components.officialIdentity;
  const independent = countIndependentSignals(candidate, context.config);
  const alertConditionsMet =
    context.config.discovery.immediateAlert.enabled &&
    repositorySignal >= context.config.discovery.immediateAlert.minRepositorySignal &&
    independent.count >= context.config.discovery.immediateAlert.minIndependentSignalCount;

  const tracked = isTracked(candidate, context.trackedUrls);

  let disposition: DiscoveryDisposition;
  let alert = false;
  let promotionEligible = true;
  let dispositionReason: string;

  if (candidate.archived) {
    disposition = "suppressed";
    promotionEligible = false;
    dispositionReason = "repository is archived";
  } else if (tracked) {
    if (hasFreshMomentum(candidate, context.now)) {
      disposition = "tracked";
      promotionEligible = false;
      dispositionReason =
        "tracked with fresh momentum; kept in queue but not eligible for automatic research promotion";
    } else {
      disposition = "suppressed";
      promotionEligible = false;
      dispositionReason = `tracked without fresh momentum (no push within ${DISCOVERY_TRACKED_FRESH_DAYS} days and no positive 24h star delta)`;
    }
  } else if (alertConditionsMet) {
    disposition = "alert";
    alert = true;
    dispositionReason = `repository signal ${repositorySignal} meets threshold ${context.config.discovery.immediateAlert.minRepositorySignal} and ${independent.count} independent non-GitHub sources meet required ${context.config.discovery.immediateAlert.minIndependentSignalCount}`;
  } else if (total < DISCOVERY_QUEUE_MIN_SCORE) {
    disposition = "suppressed";
    dispositionReason = `total score ${total} below queue floor ${DISCOVERY_QUEUE_MIN_SCORE}`;
  } else if (repositorySignal >= DISCOVERY_NEW_SIGNAL_FLOOR) {
    disposition = "new";
    dispositionReason = `repository signal ${repositorySignal} at or above ${DISCOVERY_NEW_SIGNAL_FLOOR}`;
  } else {
    disposition = "watch";
    dispositionReason = `repository signal ${repositorySignal} below ${DISCOVERY_NEW_SIGNAL_FLOOR}`;
  }

  return {
    ...candidate,
    disposition,
    alert,
    promotionEligible,
    score: { total, repositorySignal, components },
    reasons: buildReasons(candidate, context, components, repositorySignal, independent, tracked, disposition, dispositionReason),
  };
}

/**
 * Rank all candidates and cap the queue at
 * config.discovery.maxDailyCandidates (v2 validation already caps it at 20).
 */
export function buildDiscoveryQueue(
  candidates: DiscoveryCandidate[],
  context: DiscoveryRankContext
): DiscoveryQueue {
  const evaluated = candidates.map((candidate) => evaluateDiscoveryCandidate(candidate, context));
  const counts: DiscoveryQueue["counts"] = {
    totalEvaluated: evaluated.length,
    queued: 0,
    suppressed: 0,
    alert: 0,
    tracked: 0,
    new: 0,
    watch: 0,
  };
  for (const candidate of evaluated) {
    counts[candidate.disposition] += 1;
  }

  const queued = evaluated
    .filter((candidate) => candidate.disposition !== "suppressed")
    .sort(
      (left, right) =>
        right.score.total - left.score.total || left.canonicalUrl.localeCompare(right.canonicalUrl)
    )
    .slice(0, context.config.discovery.maxDailyCandidates);
  counts.queued = queued.length;

  return { generatedAt: context.now.toISOString(), candidates: queued, counts };
}

/**
 * Count distinct independent non-GitHub corroboration signals: attention
 * evidence whose source ID is an enabled community source with role
 * "corroboration". GitHub-derived provenance (`lane:*`, `query:*`,
 * `github_org_seed:*`) and raw star counts never satisfy this condition.
 */
export function countIndependentSignals(candidate: DiscoveryCandidate, config: ResearchConfig): IndependentSignals {
  const corroborationIds = new Set(
    config.discovery.communitySources
      .filter((source) => source.enabled && source.role === "corroboration")
      .map((source) => source.id)
  );
  const sourceIds: string[] = [];
  for (const evidence of candidate.attentionEvidence) {
    if (corroborationIds.has(evidence.sourceId) && !sourceIds.includes(evidence.sourceId)) {
      sourceIds.push(evidence.sourceId);
    }
  }
  return { count: sourceIds.length, sourceIds };
}

function scoreComponents(candidate: DiscoveryCandidate, context: DiscoveryRankContext): DiscoveryScoreComponents {
  return {
    momentum: scoreMomentum(candidate, context.now),
    officialIdentity: scoreOfficialIdentity(candidate, context.config),
    corroboration: Math.min(countIndependentSignals(candidate, context.config).count, DISCOVERY_CORROBORATION_CAP) * 5,
    relevance: clamp(Math.round((candidate.relevanceInput / 100) * 15), 0, 15),
    evidenceQuality: clamp(Math.round((candidate.evidenceQualityInput / 100) * 10), 0, 10),
  };
}

function scoreMomentum(candidate: DiscoveryCandidate, now: Date): number {
  let score = 0;
  if (candidate.stargazersCount >= 5000) score += 12;
  else if (candidate.stargazersCount >= 1000) score += 10;
  else if (candidate.stargazersCount >= 500) score += 8;
  else if (candidate.stargazersCount >= 100) score += 6;
  else if (candidate.stargazersCount >= 10) score += 4;
  else score += 2;

  if (candidate.forksCount >= 500) score += 8;
  else if (candidate.forksCount >= 100) score += 6;
  else if (candidate.forksCount >= 50) score += 5;
  else if (candidate.forksCount >= 10) score += 3;
  else if (candidate.forksCount >= 5) score += 2;
  else score += 1;

  const pushedAt = Date.parse(candidate.pushedAt ?? "");
  if (Number.isFinite(pushedAt)) {
    const ageDays = Math.max(0, (now.getTime() - pushedAt) / (24 * 60 * 60 * 1000));
    if (ageDays <= 7) score += 10;
    else if (ageDays <= 30) score += 7;
    else if (ageDays <= 180) score += 4;
  }

  // Baseline-unknown (null) 24h deltas earn nothing; only real positive
  // growth adds momentum, capped at 10.
  if (candidate.starDelta24h !== null && candidate.starDelta24h > 0) {
    score += Math.min(10, candidate.starDelta24h);
  }

  return Math.min(score, 40);
}

function scoreOfficialIdentity(candidate: DiscoveryCandidate, config: ResearchConfig): number {
  const seedOrgs = new Set(config.discovery.officialOrganizations.map((seed) => seed.github));
  let score = seedOrgs.has(candidate.owner) ? 12 : 0;
  if (candidate.sourceIds.some((sourceId) => sourceId.startsWith("github_org_seed:"))) score += 3;
  return score;
}

function isTracked(candidate: DiscoveryCandidate, trackedUrls: string[]): boolean {
  return trackedUrls.includes(candidate.canonicalUrl);
}

function hasFreshMomentum(candidate: DiscoveryCandidate, now: Date): boolean {
  const pushedAt = Date.parse(candidate.pushedAt ?? "");
  if (Number.isFinite(pushedAt)) {
    const ageDays = (now.getTime() - pushedAt) / (24 * 60 * 60 * 1000);
    if (ageDays >= 0 && ageDays <= DISCOVERY_TRACKED_FRESH_DAYS) return true;
  }
  return candidate.starDelta24h !== null && candidate.starDelta24h > 0;
}

function buildReasons(
  candidate: DiscoveryCandidate,
  context: DiscoveryRankContext,
  components: DiscoveryScoreComponents,
  repositorySignal: number,
  independent: IndependentSignals,
  tracked: boolean,
  disposition: DiscoveryDisposition,
  dispositionReason: string
): string[] {
  const reasons = [
    `momentum: ${components.momentum}/40 (stars ${candidate.stargazersCount}, forks ${candidate.forksCount}, pushed ${candidate.pushedAt ?? "unknown"}, 24h star delta ${candidate.starDelta24h === null ? "baseline-unknown" : candidate.starDelta24h})`,
    `official identity: ${components.officialIdentity}/15 (owner ${candidate.owner}${officialIdentityDetail(candidate, context.config)})`,
    `corroboration: ${components.corroboration}/20 (${independent.count} independent non-GitHub corroboration sources: ${independent.sourceIds.join(", ") || "none"})`,
    `relevance: ${components.relevance}/15 (technical relevance input ${candidate.relevanceInput}/100)`,
    `evidence quality: ${components.evidenceQuality}/10 (evidence quality input ${candidate.evidenceQualityInput}/100)`,
  ];
  if (tracked) reasons.push("tracked: canonical URL already observed in discovery history");
  reasons.push(`disposition: ${disposition} (${dispositionReason})`);
  if (disposition === "alert") {
    reasons.push(
      `alert threshold: repository signal ${repositorySignal} meets ${context.config.discovery.immediateAlert.minRepositorySignal}; independent signals ${independent.count} meet ${context.config.discovery.immediateAlert.minIndependentSignalCount}`
    );
  }
  return reasons;
}

function officialIdentityDetail(candidate: DiscoveryCandidate, config: ResearchConfig): string {
  const seedOrgs = new Set(config.discovery.officialOrganizations.map((seed) => seed.github));
  const parts: string[] = [];
  parts.push(seedOrgs.has(candidate.owner) ? " is a configured official organization seed" : " is not a configured official organization seed");
  if (candidate.sourceIds.some((sourceId) => sourceId.startsWith("github_org_seed:"))) {
    parts.push("org-seed provenance present");
  }
  return parts.join("; ");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
