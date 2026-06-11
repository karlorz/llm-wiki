import { normalizeCanonicalUrl } from "./config.js";

export interface CandidateForScoring {
  name: string;
  fullName: string;
  canonicalUrl: string;
  description: string;
  topics: string[];
  readmeText: string;
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
  actionability: number;
  authorityActivity: number;
  freshness: number;
  novelty: number;
}

export interface CandidateScore {
  score: number;
  components: ScoreComponents;
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
    actionability: scoreActionability(text),
    authorityActivity: scoreAuthorityActivity(candidate),
    freshness: scoreFreshness(candidate, context.now),
    novelty: scoreNovelty(candidate, context),
  };
  const score = clampScore(Object.values(components).reduce((sum, value) => sum + value, 0));

  return {
    score,
    components,
    reasons: buildReasons(candidate, context, components),
  };
}

function scoreRelevance(text: string): number {
  let score = 0;
  if (/\bagent[- ]memory\b/.test(text)) score += 12;
  else if (/\bmemory\b/.test(text)) score += 5;
  if (/\b(claude|codex|cross[- ]agent|mcp)\b/.test(text)) score += 8;
  if (/\bsession continuity\b|\bsession[- ]continuity\b/.test(text)) score += 7;
  if (/\b(obsidian|markdown|knowledge base|second brain)\b/.test(text)) score += 4;
  if (/\b(sqlite|local[- ]first|sync)\b/.test(text)) score += 4;
  return Math.min(score, 35);
}

function scoreActionability(text: string): number {
  let score = 0;
  if (/\b(markdown|knowledge base|export)\b/.test(text)) score += 8;
  if (/\b(sqlite|local storage|local[- ]first)\b/.test(text)) score += 6;
  if (/\b(cli|hook|hooks|integration)\b/.test(text)) score += 5;
  if (/\bmcp\b/.test(text)) score += 4;
  if (/\b(obsidian|sync)\b/.test(text)) score += 2;
  return Math.min(score, 25);
}

function scoreAuthorityActivity(candidate: CandidateForScoring): number {
  let score = 0;
  if (candidate.stargazersCount >= 500) score += 10;
  else if (candidate.stargazersCount >= 100) score += 6;
  else if (candidate.stargazersCount >= 10) score += 3;

  if (candidate.forksCount >= 50) score += 5;
  else if (candidate.forksCount >= 10) score += 3;

  if (!candidate.archived) score += 5;
  return Math.min(score, 20);
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

function scoreNovelty(candidate: CandidateForScoring, context: ScoreContext): number {
  const canonicalUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
  const known = [...context.knownCanonicalUrls, ...context.existingTaskUrls].map(normalizeCanonicalUrl);
  return known.includes(canonicalUrl) ? 0 : 10;
}

function buildReasons(candidate: CandidateForScoring, context: ScoreContext, components: ScoreComponents): string[] {
  const reasons = [
    `relevance: ${components.relevance}/35 for agent memory and session-continuity match strength`,
    `implementation signals: ${components.actionability}/25 for Markdown, SQLite, MCP, hooks, or sync details`,
    `authority/activity: ${components.authorityActivity}/20 from stars, forks, and archive status`,
  ];

  if (components.freshness > 0) reasons.push(`recent activity: ${components.freshness}/10 from pushed_at ${candidate.pushedAt}`);
  else reasons.push(`stale: 0/10 from pushed_at ${candidate.pushedAt}`);

  const canonicalUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
  const known = [...context.knownCanonicalUrls, ...context.existingTaskUrls].map(normalizeCanonicalUrl);
  if (known.includes(canonicalUrl)) reasons.push("already known: 0/10 novelty because source is already tracked");
  else reasons.push("novel source: 10/10 novelty because source is not yet tracked");

  return reasons;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
