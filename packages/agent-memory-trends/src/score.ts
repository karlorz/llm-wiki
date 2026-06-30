import { normalizeCanonicalUrl } from "./config.js";
import type { ProposalEvidence } from "./synthesis.js";

export type EvidenceQualityDepth =
  | "metadata_only"
  | "readme_summary"
  | "feature_surface"
  | "implementation_surface"
  | "integration_surface";

export interface EvidenceQuality {
  depth: EvidenceQualityDepth;
  sourceInspectionRecommended: boolean;
  signals: string[];
  summary: string;
}

export interface CandidateForScoring {
  name: string;
  fullName: string;
  canonicalUrl: string;
  description: string;
  topics: string[];
  readmeText: string;
  readmeEvidence?: ProposalEvidence[];
  evidenceQuality?: EvidenceQuality;
  laneIds?: string[];
  qualityGate?: "passed" | "multi_query_exception" | "failed";
  evidenceFamilies?: string[];
  stargazersCount: number;
  forksCount: number;
  pushedAt: string;
  archived: boolean;
}

export interface ScoreContext {
  now: Date;
  knownCanonicalUrls: string[];
  existingTaskUrls: string[];
}

export interface ScoreComponents {
  relevance: number;
  implementationEvidence: number;
  authorityMomentum: number;
  freshness: number;
  noveltyOrTracking: number;
}

export interface CandidateScore {
  score: number;
  components: ScoreComponents;
  trackingStatus: "new" | "tracked_existing";
  reasons: string[];
}

export function scoreCandidate(candidate: CandidateForScoring, context: ScoreContext): CandidateScore {
  const text = [
    candidate.name,
    candidate.fullName,
    candidate.description,
    candidate.topics.join(" "),
    candidate.readmeText,
  ]
    .join("\n")
    .toLowerCase();

  const components: ScoreComponents = {
    relevance: scoreRelevance(text),
    implementationEvidence: scoreImplementationEvidence(text, candidate.evidenceFamilies ?? []),
    authorityMomentum: scoreAuthorityMomentum(candidate),
    freshness: scoreFreshness(candidate, context.now),
    noveltyOrTracking: scoreNoveltyOrTracking(candidate, context),
  };
  const score = clampScore(Object.values(components).reduce((sum, value) => sum + value, 0));
  const trackingStatus = isKnownCandidate(candidate, context) ? "tracked_existing" : "new";

  return {
    score,
    components,
    trackingStatus,
    reasons: buildReasons(candidate, context, components, trackingStatus),
  };
}

function scoreRelevance(text: string): number {
  let score = 0;
  if (/\b(agent[- ]memory|coding agent memory)\b/.test(text)) score += 12;
  else if (/\bmemory\b/.test(text)) score += 6;
  if (/\b(claude|codex|coding agent|cross[- ]agent|mcp)\b/.test(text)) score += 8;
  if (/\b(session continuity|session[- ]continuity|checkpoint|context consolidation)\b/.test(text)) score += 6;
  if (/\b(workflow|skill|skills|subagent|agent trajector(y|ies))\b/.test(text)) score += 4;
  if (/\b(obsidian|markdown|wiki|vault|knowledge base|second brain|sqlite|database|local[- ]first|local search|sync)\b/.test(text)) {
    score += 4;
  }
  return Math.min(score, 30);
}

function scoreImplementationEvidence(text: string, evidenceFamilies: string[]): number {
  let score = 0;
  score += Math.min(evidenceFamilies.length, 5) * 3;
  if (/\b(markdown|knowledge base|wiki|vault|export)\b/.test(text)) score += 5;
  if (/\b(sqlite|database|local storage|local[- ]first|local search)\b/.test(text)) score += 5;
  if (/\b(cli|hook|hooks|command|commands|integration)\b/.test(text)) score += 4;
  if (/\b(skill|skills|subagent|sub-agent|workflow)\b/.test(text)) score += 4;
  if (/\b(checkpoint|context consolidation|memory consolidation|distill|distillation|dream)\b/.test(text)) score += 4;
  if (/\bmcp\b/.test(text)) score += 4;
  if (/\b(obsidian|sync)\b/.test(text)) score += 2;
  return Math.min(score, 25);
}

function scoreAuthorityMomentum(candidate: CandidateForScoring): number {
  let score = 0;
  if (candidate.stargazersCount >= 500) score += 12;
  else if (candidate.stargazersCount >= 100) score += 8;
  else if (candidate.stargazersCount >= 10) score += 4;

  if (candidate.forksCount >= 50) score += 8;
  else if (candidate.forksCount >= 10) score += 5;
  else if (candidate.forksCount >= 5) score += 3;

  const laneIds = candidate.laneIds ?? [];
  if (laneIds.includes("monthly_authority")) score += 3;
  if (laneIds.includes("weekly_momentum")) score += 2;
  if (!candidate.archived) score += 2;
  return Math.min(score, 25);
}

function scoreFreshness(candidate: CandidateForScoring, now: Date): number {
  const pushedAt = Date.parse(candidate.pushedAt);
  if (!Number.isFinite(pushedAt)) return 0;
  const ageDays = Math.max(0, (now.getTime() - pushedAt) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return 10;
  if (ageDays <= 30) return 7;
  if (ageDays <= 180) return 4;
  return 0;
}

function scoreNoveltyOrTracking(candidate: CandidateForScoring, context: ScoreContext): number {
  return isKnownCandidate(candidate, context) ? 6 : 10;
}

function buildReasons(
  candidate: CandidateForScoring,
  context: ScoreContext,
  components: ScoreComponents,
  trackingStatus: "new" | "tracked_existing"
): string[] {
  const reasons = [
    `lane evidence: ${(candidate.laneIds ?? ["legacy_flat"]).join(", ")} with quality gate ${candidate.qualityGate ?? "passed"}`,
    `relevance: ${components.relevance}/30 for coding-agent memory and workflow match strength`,
    `implementation signals: ${components.implementationEvidence}/25 for evidence families, Markdown, database/search, MCP, hooks, skills, or workflow details`,
    `authority/momentum: ${components.authorityMomentum}/25 from stars, forks, lane presence, and archive status`,
  ];

  if (components.freshness > 0) reasons.push(`recent activity: ${components.freshness}/10 from pushed_at ${candidate.pushedAt}`);
  else reasons.push(`stale: 0/10 from pushed_at ${candidate.pushedAt}`);

  if (trackingStatus === "tracked_existing") {
    reasons.push("already known: 6/10 novelty_or_tracking because source is tracked existing and remains visible");
    reasons.push("tracked existing source: duplicate capture creation should remain suppressed");
  } else {
    reasons.push("novel source: 10/10 novelty_or_tracking because source is not yet tracked");
  }

  return reasons;
}

function isKnownCandidate(candidate: CandidateForScoring, context: ScoreContext): boolean {
  const canonicalUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
  const known = [...context.knownCanonicalUrls, ...context.existingTaskUrls].map(normalizeCanonicalUrl);
  return known.includes(canonicalUrl);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
