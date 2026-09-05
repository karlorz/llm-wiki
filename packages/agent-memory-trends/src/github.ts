import { normalizeCanonicalUrl, type GithubLane, type GithubQualityGate, type ResearchConfig, type ResearchQuery } from "./config.js";
import { err, ok, type Result } from "./types.js";
import { scoreCandidate, type CandidateForScoring, type CandidateScore, type EvidenceQuality } from "./score.js";
import type { ProposalEvidence } from "./synthesis.js";

export type { EvidenceQuality, EvidenceQualityDepth } from "./score.js";

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
  /**
   * Diagnostic mode runs an extra unqualified count query per executed
   * search query so the lane report can separate pre-date-filter volume
   * (unqualified `total_count`) from the qualified result set. Ordinary
   * collection never runs these extra queries, so API usage is unchanged
   * outside diagnostic mode.
   */
  diagnostic?: boolean;
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
  evidenceQuality: EvidenceQuality;
  score: CandidateScore;
}

export interface GithubLaneDiagnostics {
  /** Diagnostic lane label; the normalized flat portfolio lane reads "legacy". */
  laneId: string;
  configuredQueryCount: number;
  executedQueryCount: number;
  /**
   * Sum of unqualified (pre-date-filter) `total_count` values. Present only
   * in diagnostic mode, which runs one extra count query per executed query.
   */
  unqualifiedTotalCount?: number;
  /** Sum of qualified `total_count` values from the real search queries. */
  qualifiedTotalCount: number;
  /** Sum of qualified result item counts (the per_page-bounded items). */
  searchResultCount: number;
  /** Unique merged candidates attributed to the lane. */
  mergedCandidateCount: number;
  /** Merged candidates in the lane that went through README/evidence processing. */
  readmeProcessedCount: number;
  /** Raw (quality-passed, capped) candidates in the lane with gate "passed". */
  qualityPassedCount: number;
  /** Raw (quality-passed or multi-query-exception, capped) candidates in the lane. */
  rawEligibleCount: number;
  /** Selected candidates attributed to the lane (before actual duplicate suppression). */
  selectedCount: number;
  /** Lane search items merged into an already-known candidate (intra-run merge dedup). */
  mergedDuplicateCount: number;
  /**
   * True when the query/API budget stopped the run before the lane's
   * configured queries all executed or before all of the lane's merged
   * candidates were README/evidence-processed.
   */
  budgetExhausted: boolean;
}

export interface GithubCollectionOutput {
  rateLimit: RateLimitState;
  apiCallsUsed: number;
  rawCandidateCount: number;
  selectedCandidates: SelectedGithubCandidate[];
  laneDiagnostics: GithubLaneDiagnostics[];
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

  const laneDiagnostics: GithubLaneDiagnostics[] = [];
  const laneDiagnosticByLaneId = new Map<string, GithubLaneDiagnostics>();
  for (const lane of config.github.lanes) {
    const diagnostics = createLaneDiagnostics(lane);
    laneDiagnostics.push(diagnostics);
    laneDiagnosticByLaneId.set(lane.id, diagnostics);
  }

  const byUrl = new Map<string, RawCandidate>();
  let queriesUsed = 0;
  for (const lane of config.github.lanes) {
    const laneDiagnostic = laneDiagnosticByLaneId.get(lane.id)!;
    for (const query of lane.queries) {
      // A diagnostic query is a qualified search plus its unqualified count
      // query; reserve both calls so the run never exceeds the API budget.
      const requiredApiCalls = options.diagnostic ? 2 : 1;
      if (queriesUsed >= config.github.maxQueries || apiCallsUsed + requiredApiCalls > config.github.apiCallBudget) break;
      const search = await searchRepositories(options.runGh, lane, query, options.now);
      apiCallsUsed += 1;
      queriesUsed += 1;
      if (!search.ok) return search;
      laneDiagnostic.executedQueryCount += 1;
      laneDiagnostic.qualifiedTotalCount += search.data.totalCount;
      laneDiagnostic.searchResultCount += search.data.items.length;

      if (options.diagnostic) {
        const unqualified = await fetchUnqualifiedTotalCount(options.runGh, query.query);
        apiCallsUsed += 1;
        if (!unqualified.ok) return unqualified;
        laneDiagnostic.unqualifiedTotalCount = (laneDiagnostic.unqualifiedTotalCount ?? 0) + unqualified.data;
      }

      for (const item of search.data.items) {
        const candidate = parseSearchItem(item, lane.id, query.id);
        if (!candidate) continue;
        const existing = byUrl.get(candidate.canonicalUrl);
        if (existing) {
          mergeCandidate(existing, candidate);
          laneDiagnostic.mergedDuplicateCount += 1;
        } else {
          byUrl.set(candidate.canonicalUrl, candidate);
        }
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
    candidate.evidenceQuality = classifyEvidenceQuality(candidate);
    candidate.qualityGate = evaluateCandidateQualityGate(candidate, config.github.lanes);
    for (const laneId of candidate.laneIds) {
      laneDiagnosticByLaneId.get(laneId)!.readmeProcessedCount += 1;
    }
  }

  const rawCandidates = unfilteredCandidates
    .filter((candidate) => candidate.qualityGate !== "failed")
    .slice(0, config.github.maxRawCandidates);

  const selectedCandidates = rawCandidates
    .map((candidate) => ({
      ...candidate,
      evidenceQuality: candidate.evidenceQuality ?? classifyEvidenceQuality(candidate),
      score: scoreCandidate(candidate, {
        now: options.now,
        knownCanonicalUrls: options.knownCanonicalUrls ?? [],
        existingTaskUrls: options.existingTaskUrls ?? [],
      }),
    }))
    .sort((left, right) => right.score.score - left.score.score || left.fullName.localeCompare(right.fullName))
    .slice(0, config.github.maxSelectedCandidates);

  for (const candidate of byUrl.values()) {
    for (const laneId of candidate.laneIds) {
      laneDiagnosticByLaneId.get(laneId)!.mergedCandidateCount += 1;
    }
  }
  for (const candidate of rawCandidates) {
    for (const laneId of candidate.laneIds) {
      const diagnostics = laneDiagnosticByLaneId.get(laneId)!;
      diagnostics.rawEligibleCount += 1;
      if (candidate.qualityGate === "passed") diagnostics.qualityPassedCount += 1;
    }
  }
  for (const candidate of selectedCandidates) {
    for (const laneId of candidate.laneIds) {
      laneDiagnosticByLaneId.get(laneId)!.selectedCount += 1;
    }
  }

  for (const diagnostics of laneDiagnostics) {
    diagnostics.budgetExhausted =
      diagnostics.executedQueryCount < diagnostics.configuredQueryCount ||
      diagnostics.readmeProcessedCount < diagnostics.mergedCandidateCount;
  }

  return ok({
    rateLimit,
    apiCallsUsed,
    rawCandidateCount: rawCandidates.length,
    selectedCandidates,
    laneDiagnostics,
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

export function classifyEvidenceQuality(candidate: CandidateForScoring): EvidenceQuality {
  const text = buildCandidateEvidenceText(candidate);
  const signals = evidenceQualitySignals(text);
  const readmeIdentity = selectReadmeIdentityText(candidate.readmeText);
  const hasReadmeSummary = readmeIdentity.trim().length > 0;

  const hardImplementationSignals = signals.filter((signal) =>
    [
      "api",
      "cli",
      "mcp",
      "adapter",
      "parser",
      "plugin",
      "registry",
      "workflow",
      "tests",
      "source-capture",
      "source-file",
      "hook",
      "markdown",
      "sync",
    ].includes(signal)
  );
  const featureSignals = signals.filter((signal) =>
    ["adaptive", "dynamic", "selector", "fetcher", "hybrid-reasoning", "source-backed"].includes(signal)
  );
  const integrationSignals = signals.filter((signal) =>
    ["agent-memory", "codex", "claude", "mcp", "plugin", "registry", "source-capture", "vault", "skillwiki"].includes(signal)
  );

  let depth: EvidenceQuality["depth"] = "metadata_only";
  if (isMetadataOnlyEvidence(signals, text)) {
    depth = "metadata_only";
  } else if (integrationSignals.length >= 2 && hardImplementationSignals.length > 0) {
    depth = "integration_surface";
  } else if (hardImplementationSignals.length > 0 && featureSignals.length === 0) {
    depth = "implementation_surface";
  } else if (featureSignals.length > 0) {
    depth = "feature_surface";
  } else if (hasReadmeSummary) {
    depth = "readme_summary";
  }

  const sourceInspectionRecommended = ["feature_surface", "implementation_surface", "integration_surface"].includes(depth);
  return {
    depth,
    sourceInspectionRecommended,
    signals,
    summary: evidenceQualitySummary(depth, signals),
  };
}

function evidenceQualitySignals(text: string): string[] {
  const normalized = text.toLowerCase();
  const matchers: Array<[string, RegExp]> = [
    ["agent-memory", /\bagent[- ]memory\b/],
    ["codex", /\bcodex\b/],
    ["claude", /\bclaude\b/],
    ["skillwiki", /\bskillwiki\b/],
    ["vault", /\bvault\b/],
    ["mcp", /\bmcp\b/],
    ["api", /\bapi\b/],
    ["cli", /\bcli\b/],
    ["adapter", /\badapters?\b/],
    ["parser", /\bparsers?\b/],
    ["fetcher", /\bfetchers?\b/],
    ["selector", /\bselectors?\b/],
    ["plugin", /\bplugins?\b/],
    ["registry", /\bregistr(?:y|ies)\b/],
    ["workflow", /\bworkflows?\b/],
    ["tests", /\btests?\b/],
    ["source-capture", /\bsource[- ]captures?\b/],
    ["source-file", /\bsource[- ]files?\b/],
    ["source-backed", /\bsource[- ]backed\b/],
    ["adaptive", /\badaptive\b/],
    ["dynamic", /\bdynamic\b/],
    ["hybrid-reasoning", /\bhybrid[- ]reasoning\b/],
    ["hook", /\bhooks?\b/],
    ["markdown", /\bmarkdown\b/],
    ["sync", /\bsync\b/],
  ];
  return matchers.filter(([, pattern]) => pattern.test(normalized)).map(([signal]) => signal);
}

function isMetadataOnlyEvidence(signals: string[], text: string): boolean {
  if (signals.length === 0) return true;
  const metadataSignals = new Set(["agent-memory", "mcp", "codex", "claude"]);
  const hasOnlyMetadataSignals = signals.every((signal) => metadataSignals.has(signal));
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return hasOnlyMetadataSignals && wordCount <= 16;
}

function evidenceQualitySummary(depth: EvidenceQuality["depth"], signals: string[]): string {
  if (depth === "metadata_only") return "Only shallow marker evidence is available; source inspection is not automatically recommended.";
  if (depth === "readme_summary") return "README evidence has a bounded summary but no concrete implementation surface.";

  const listed = signals.length > 0 ? signals.join(", ") : "none";
  if (depth === "integration_surface") return `README evidence exposes integration surfaces: ${listed}.`;
  return `README evidence exposes implementation surfaces: ${listed}.`;
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

interface SearchRepositoriesOutput {
  items: SearchRepositoryItem[];
  totalCount: number;
}

async function searchRepositories(
  runGh: GhRunner,
  lane: GithubLane,
  query: ResearchQuery,
  now: Date
): Promise<Result<SearchRepositoriesOutput>> {
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
  return ok({
    items: Array.isArray(items) ? (items as SearchRepositoryItem[]) : [],
    totalCount: typeof parsed.data.total_count === "number" ? parsed.data.total_count : 0,
  });
}

/**
 * Diagnostic-mode-only unqualified count query: the raw query without the
 * lane's date window, sized to one item since only `total_count` is read.
 */
async function fetchUnqualifiedTotalCount(runGh: GhRunner, query: string): Promise<Result<number>> {
  const result = await ghApi(runGh, [
    "--method",
    "GET",
    "/search/repositories",
    "-f",
    `q=${query}`,
    "-f",
    "per_page=1",
  ]);
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  const total = parsed.data.total_count;
  return ok(typeof total === "number" && Number.isFinite(total) ? total : 0);
}

function createLaneDiagnostics(lane: GithubLane): GithubLaneDiagnostics {
  return {
    laneId: diagnosticLaneId(lane),
    configuredQueryCount: lane.queries.length,
    executedQueryCount: 0,
    qualifiedTotalCount: 0,
    searchResultCount: 0,
    mergedCandidateCount: 0,
    readmeProcessedCount: 0,
    qualityPassedCount: 0,
    rawEligibleCount: 0,
    selectedCount: 0,
    mergedDuplicateCount: 0,
    budgetExhausted: false,
  };
}

export function diagnosticLaneId(lane: GithubLane): string {
  // The flat legacy portfolio parses into a synthetic "legacy_flat" lane;
  // diagnostics label it by its public "legacy" name.
  return lane.id === "legacy_flat" ? "legacy" : lane.id;
}

async function fetchReadme(runGh: GhRunner, fullName: string): Promise<Result<string>> {
  const result = await ghApi(runGh, [`/repos/${fullName}/readme`]);
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.data.stdout);
  if (!parsed.ok) return parsed;
  if (parsed.data.encoding !== "base64" || typeof parsed.data.content !== "string") return ok("");
  return ok(Buffer.from(parsed.data.content, "base64").toString("utf8"));
}

export async function ghApi(runGh: GhRunner, args: string[]): Promise<Result<GhRunResult>> {
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
  return hasTargetTopicEvidence(candidate) && passesAuthorityGate(candidate, gate) && candidate.evidenceFamilies.length >= gate.minEvidenceFamilies;
}

function passesAuthorityGate(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  const starsPass = gate.minStars <= 0 || candidate.stargazersCount >= gate.minStars;
  const forksPass = gate.minForks <= 0 || candidate.forksCount >= gate.minForks;
  if (gate.minStars > 0 && gate.minForks > 0) return starsPass || forksPass;
  return starsPass && forksPass;
}

function passesMultiQueryException(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  return (
    hasTargetTopicEvidence(candidate) &&
    gate.allowMultiQueryException &&
    candidate.queryIds.length >= 2 &&
    candidate.evidenceFamilies.length >= Math.max(2, gate.minEvidenceFamilies)
  );
}

function passesStrongEvidenceException(candidate: RawCandidate, gate: GithubQualityGate): boolean {
  return (
    hasTargetTopicEvidence(candidate) &&
    gate.allowStrongEvidenceException &&
    candidate.evidenceFamilies.length >= Math.max(3, gate.minEvidenceFamilies)
  );
}

function hasTargetTopicEvidence(candidate: RawCandidate): boolean {
  return candidate.evidenceFamilies.includes("coding_agent");
}

function extractEvidenceFamilies(candidate: CandidateForScoring): string[] {
  const text = buildCandidateEvidenceText(candidate).toLowerCase();

  const matchers: Array<[string, RegExp]> = [
    [
      "coding_agent",
      /\b(agent[- ]memory|coding agents?|code agents?|ai coding agents?|claude code|claude (agent|memory|workflow|skill|skills|hook|hooks)|codex (agent|memory|workflow|skill|skills|hook|hooks)|opencode|autonomous coding|agentic coding|agent workflows?|agent skills?|subagents?)\b/,
    ],
    ["memory_state", /\b(memory|checkpoint|session continuity|session-continuity|context consolidation|cross-session|state)\b/],
    ["workflow_distillation", /\b(distill|distillation|dream|reflection|workflow|lesson|summarize|consolidation)\b/],
    ["skills_subagents", /\b(skill|skills|subagent|sub-agent|hook|hooks|command|commands)\b/],
    ["goal_judge", /\b(goal|judge|eval|evaluation|benchmark)\b/],
    ["knowledge_store", /\b(sqlite|database|local search|vector|search|markdown|wiki|vault|knowledge base|trajectory|trajectories)\b/],
    ["self_improvement", /\b(self[- ]improv|autonomous|feedback|iteration|learn)\b/],
  ];

  return matchers.filter(([, pattern]) => pattern.test(text)).map(([family]) => family);
}

function buildCandidateEvidenceText(candidate: CandidateForScoring): string {
  return [
    candidate.name,
    candidate.fullName,
    candidate.description,
    candidate.topics.join(" "),
    selectReadmeIdentityText(candidate.readmeText),
  ].join("\n");
}

function selectReadmeIdentityText(readmeText: string): string {
  const kept: string[] = [];
  let sectionCount = 0;

  for (const rawLine of readmeText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isMarkdownBadgeLine(line)) continue;
    if (/^#{2,}\s+(contents|table of contents|toc)\b/i.test(line)) break;

    if (/^#{2,}\s+/.test(line)) {
      sectionCount += 1;
      if (sectionCount > 2) break;
    }

    kept.push(line);
    if (kept.join("\n").length >= 2500) break;
  }

  return kept.join("\n").slice(0, 2500);
}

function isMarkdownBadgeLine(line: string): boolean {
  return /^(\[?!?\[[^\]]*\]\([^)]+\)\s*)+$/.test(line);
}

function parseRateLimit(text: string): RateLimitState {
  const parsed = JSON.parse(text) as RateLimitState;
  return parsed;
}

export function parseJsonObject(text: string): Result<Record<string, unknown>> {
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
