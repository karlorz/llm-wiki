import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage, type VaultPage } from "../utils/vault.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { runGraphBuild } from "./graph.js";
import { fuseRankings, RRF_K } from "../utils/rrf.js";
import { loadVectorIndex, rankVectorIndex } from "../utils/vector-index.js";

export type QueryScope = "typed" | "work" | "all";

export interface QueryInput {
  text: string;
  vault: string;
  limit?: number;
  includePending?: boolean;
  hybrid?: boolean;
  scope?: QueryScope | string;
}

export interface QueryResult {
  path: string;
  score: number;
  title: string;
  type: string;
}

export interface QueryOutput {
  results: QueryResult[];
  pending_sources?: import("../utils/source-lifecycle.js").SourceLifecycleItem[];
  ranking_guardrails?: {
    repetitive_historical_cycles_suppressed: boolean;
    historical_cycle_page_count: number;
  };
  hybrid?: { used: true; rrf_k: number };
  humanHint: string;
}

interface GraphData {
  adjacency: Record<string, string[]>;
  adamicAdar: Record<string, Record<string, number>>;
}

// Signal weights from wiki-query SKILL.md 4-signal ranking
const W_KEYWORD = 2.0;       // base relevance (title/tag/body match)
const W_SOURCE_OVERLAP = 4.0;
const W_WIKILINK = 3.0;
const W_ADAMIC_ADAR = 1.5;
const W_TYPE_AFFINITY = 1.0;

// Non-seed discount: pages with zero keyword match get their structural
// signals scaled down so they never outrank direct keyword matches.
const NON_SEED_FACTOR = 0.4;

// Structural signals reward connection to relevant pages. On large vaults,
// generic query terms turn thousands of pages into weak keyword seeds, and
// page families that share identical source lists (packet/report clusters)
// self-reinforce via source-overlap sums until they outrank strong direct
// matches — the same failure mode the 2026-08-04 historical-cycle guardrail
// addressed for research cycles. For scope=work and the work pool of
// scope=all, only the strongest keyword seeds provide structural signal.
// Default typed ranking (and the typed pool of scope=all) is unchanged.
const STRUCTURAL_SEED_TOP_K = 20;
const HISTORICAL_CYCLE_FACTOR = 0.55;
const HISTORICAL_CYCLE_RE = /(?:^|\/)(?:\d{4}-\d{2}-\d{2}-)?.*\b(?:daily|deep|maintenance|research|office[- ]hours|sleep)\b.*\b(?:cycle|run|review|research)\b/i;

// Conceptual query indicators for type affinity signal
const CONCEPT_INDICATORS = new Set([
  "what", "how", "why", "concept", "idea", "pattern", "principle",
  "theory", "approach", "method", "framework", "model", "definition",
]);

function resolveQueryScope(value: string | undefined): QueryScope | null {
  const scope = value ?? "typed";
  if (scope === "typed" || scope === "work" || scope === "all") return scope;
  return null;
}

export async function runQuery(
  input: QueryInput,
): Promise<{ exitCode: number; result: Result<QueryOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const scope = resolveQueryScope(input.scope);
  if (!scope) {
    return {
      exitCode: ExitCode.USAGE,
      result: err("USAGE", { message: "scope must be typed, work, or all" }),
    };
  }

  const limit = input.limit ?? 10;
  const queryTerms = tokenize(input.text);
  const candidates = queryCandidates(scan.data.typedKnowledge, scan.data.workItems, scope);

  if (queryTerms.length === 0) {
    return {
      exitCode: ExitCode.OK,
      result: ok({ results: [], humanHint: "no query terms" }),
    };
  }

  // Load or build graph (builds if missing or stale > 24h)
  const graph = await loadOrBuildGraph(input.vault);

  const pages: PageData[] = [];
  for (const p of candidates) {
    const text = await readPage(p);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;

    const title = String(fm.data.title ?? "");
    const type = String(fm.data.type ?? (p.relPath.includes("/work/") ? "work" : ""));
    const tags = Array.isArray(fm.data.tags)
      ? fm.data.tags.map(String)
      : [];
    const sources = Array.isArray(fm.data.sources)
      ? fm.data.sources.map(String)
      : [];

    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;

    const keywordScore = computeKeywordScore(queryTerms, title, tags, body, p.relPath);
    pages.push({
      relPath: p.relPath,
      title,
      type,
      tags,
      sources,
      keywordScore,
      historicalCycle: isHistoricalCyclePage(p.relPath, title),
    });
  }

  // scope=all ranks work and typed in separate pools so typed source-overlap
  // cannot drown Layer-3 work, then zip-merges work-first. Default typed
  // ranking is unchanged because typed pages never enter the work pool.
  let structural: QueryResult[];
  let results: QueryResult[];
  let rankingGuardrails: QueryOutput["ranking_guardrails"];
  if (scope === "all") {
    const rankedWork = rankPages(
      pages.filter((page) => isWorkPath(page.relPath)),
      graph,
      queryTerms,
      STRUCTURAL_SEED_TOP_K,
    );
    const rankedTyped = rankPages(pages.filter((page) => !isWorkPath(page.relPath)), graph, queryTerms);
    structural = [...rankedWork.results, ...rankedTyped.results];
    results = zipMergeScopeResults(rankedWork.results, rankedTyped.results, limit);
    rankingGuardrails = rankedTyped.rankingGuardrails;
  } else {
    const ranked = rankPages(
      pages,
      graph,
      queryTerms,
      scope === "work" ? STRUCTURAL_SEED_TOP_K : undefined,
    );
    structural = ranked.results;
    results = structural.slice(0, limit);
    rankingGuardrails = ranked.rankingGuardrails;
  }

  let hybridMeta: QueryOutput["hybrid"];
  if (input.hybrid) {
    const index = await loadVectorIndex(input.vault);
    if (!index.ok) return { exitCode: ExitCode.USAGE, result: index };
    const byPath = new Map(pages.map((page) => [page.relPath, page]));
    const fused = fuseRankings([structural.map((row) => row.path), rankVectorIndex(index.data, input.text)]);
    results = fused.slice(0, limit).map((row) => {
      const existing = structural.find((item) => item.path === row.id);
      if (existing) return { ...existing, score: Math.round(row.score * 1000) / 1000 };
      const page = byPath.get(row.id);
      return {
        path: row.id,
        score: Math.round(row.score * 1000) / 1000,
        title: page?.title ?? "",
        type: page?.type ?? "",
      };
    });
    hybridMeta = { used: true, rrf_k: RRF_K };
  }

  let pendingSources: import("../utils/source-lifecycle.js").SourceLifecycleItem[] | undefined;
  if (input.includePending) {
    const { runSourcesPending } = await import("./sources.js");
    const pending = await runSourcesPending({
      vault: input.vault,
      match: input.text,
      limit: input.limit ?? 10,
    });
    pendingSources = pending.result.ok ? pending.result.data.items : [];
  }

  const humanHint =
    results.length === 0
      ? pendingSources && pendingSources.length > 0
        ? `no matching typed pages found\n${pendingSources.length} matching pending source(s)`
        : "no matching pages found"
      : results.map((r) => `${r.path} (score: ${r.score})`).join("\n");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      results,
      ...(pendingSources ? { pending_sources: pendingSources } : {}),
      ...(rankingGuardrails ? { ranking_guardrails: rankingGuardrails } : {}),
      ...(hybridMeta ? { hybrid: hybridMeta } : {}),
      humanHint,
    }),
  };
}

function queryCandidates(
  typedKnowledge: VaultPage[],
  workItems: VaultPage[],
  scope: QueryScope,
): VaultPage[] {
  if (scope === "work") return workItems;
  if (scope === "all") return [...typedKnowledge, ...workItems];
  return typedKnowledge;
}

interface PageData {
  relPath: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  keywordScore: number;
  historicalCycle: boolean;
}

function isWorkPath(relPath: string): boolean {
  return relPath.includes("/work/");
}

/** Generic path tokens that should not dominate work ranking. */
const GENERIC_PATH_TERMS = new Set([
  "work",
  "open",
  "projects",
  "spec",
  "plan",
  "log",
  "md",
  "http",
  "mcp",
  "and",
  "the",
  "for",
  "with",
  "from",
  "item",
  "items",
]);

function pathSegmentBonus(terms: string[], relPath: string): number {
  if (!isWorkPath(relPath)) return 0;
  const segments = new Set(
    relPath
      .toLowerCase()
      .split("/")
      .flatMap((part) => {
        const noExt = part.replace(/\.(md|markdown)$/i, "");
        return noExt === part ? [part] : [part, noExt];
      }),
  );
  let bonus = 0;
  for (const term of terms) {
    if (GENERIC_PATH_TERMS.has(term)) continue;
    if (segments.has(term)) bonus += 100;
  }
  return bonus;
}

function zipMergeScopeResults(work: QueryResult[], typed: QueryResult[], limit: number): QueryResult[] {
  const merged: QueryResult[] = [];
  const n = Math.max(work.length, typed.length);
  for (let i = 0; i < n && merged.length < limit; i++) {
    if (i < work.length) merged.push(work[i]);
    if (merged.length >= limit) break;
    if (i < typed.length) merged.push(typed[i]);
  }
  return merged;
}

function rankPages(
  pages: PageData[],
  graph: GraphData | null,
  queryTerms: string[],
  structuralSeedLimit?: number,
): {
  results: QueryResult[];
  rankingGuardrails?: QueryOutput["ranking_guardrails"];
} {
  const seedPages: PageData[] = [];
  let historicalCyclePageCount = 0;
  let hasDirectOperationalSeed = false;
  for (const page of pages) {
    if (page.historicalCycle) historicalCyclePageCount += 1;
    if (page.keywordScore <= 0) continue;
    seedPages.push(page);
    if (!page.historicalCycle) hasDirectOperationalSeed = true;
  }
  const suppressRepetitiveHistoricalCycles =
    historicalCyclePageCount >= 3 && hasDirectOperationalSeed;

  // Structural seed gating (work/all scopes): only the strongest keyword
  // matches provide structural signal, so weak-seed page families sharing
  // identical source lists cannot self-reinforce past direct matches.
  // Gating runs before historical-cycle exclusion on purpose: the gate models
  // "the strongest keyword matches", and suppression then removes cycle pages
  // from whatever survived the gate. Reordering these changes ranking.
  // Longer term, bounding per-family contribution inside scoreSourceOverlap
  // could subsume both this gate and the historical-cycle guardrail; they are
  // kept separate while default typed ranking must stay unchanged.
  const gatedSeedPages =
    structuralSeedLimit !== undefined && seedPages.length > structuralSeedLimit
      ? seedPages
          .sort(
            (a, b) =>
              b.keywordScore - a.keywordScore || a.relPath.localeCompare(b.relPath),
          )
          .slice(0, structuralSeedLimit)
      : seedPages;

  // When historical-cycle suppression is active, structural signals must not
  // use historical-cycle pages as seeds — otherwise large research-cycle
  // clusters self-reinforce via source-overlap and drown operational pages
  // even after HISTORICAL_CYCLE_FACTOR demotion.
  const structuralSeedPages = suppressRepetitiveHistoricalCycles
    ? gatedSeedPages.filter((page) => !page.historicalCycle)
    : gatedSeedPages;
  const structuralSeedPaths = new Set(
    structuralSeedPages.map((page) => page.relPath),
  );

  const results: QueryResult[] = pages
    .map((page) => {
      const sourceOverlap = scoreSourceOverlap(page, structuralSeedPages);
      const wikilink = scoreWikilink(page.relPath, structuralSeedPaths, graph);
      const aa = scoreAdamicAdar(page.relPath, structuralSeedPaths, graph);
      const typeAffinity = scoreTypeAffinity(page.type, queryTerms);
      const isSeed = page.keywordScore > 0;

      const structuralBoost =
        sourceOverlap * W_SOURCE_OVERLAP +
        wikilink * W_WIKILINK +
        aa * W_ADAMIC_ADAR;

      const composite = isSeed
        ? page.keywordScore * W_KEYWORD + structuralBoost + typeAffinity * W_TYPE_AFFINITY
        : structuralBoost * NON_SEED_FACTOR + typeAffinity * W_TYPE_AFFINITY;
      const guardedComposite = suppressRepetitiveHistoricalCycles && page.historicalCycle
        ? composite * HISTORICAL_CYCLE_FACTOR
        : composite;

      return {
        path: page.relPath,
        score: Math.round(guardedComposite * 1000) / 1000,
        title: page.title,
        type: page.type,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  return {
    results,
    rankingGuardrails: suppressRepetitiveHistoricalCycles
      ? {
          repetitive_historical_cycles_suppressed: true,
          historical_cycle_page_count: historicalCyclePageCount,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Source overlap: count shared raw sources between this page and seed pages. */
function scoreSourceOverlap(
  page: { relPath: string; sources: string[] },
  seedPages: { relPath: string; sources: string[] }[],
): number {
  if (page.sources.length === 0) return 0;
  let total = 0;
  for (const seed of seedPages) {
    if (seed.relPath === page.relPath) continue;
    const shared = page.sources.filter((s) => seed.sources.includes(s)).length;
    total += shared;
  }
  return total;
}

/** Direct wikilink: count seed pages whose adjacency includes this candidate. */
function scoreWikilink(
  candidatePath: string,
  seedPaths: Set<string>,
  graph: GraphData | null,
): number {
  if (!graph) return 0;
  let count = 0;
  for (const seedPath of seedPaths) {
    const neighbors = graph.adjacency[seedPath];
    if (neighbors && neighbors.includes(candidatePath)) count++;
  }
  return count;
}

/** Adamic-Adar: max AA score between this candidate and any seed page. */
function scoreAdamicAdar(
  candidatePath: string,
  seedPaths: Set<string>,
  graph: GraphData | null,
): number {
  if (!graph) return 0;
  let maxScore = 0;
  const aaForCandidate = graph.adamicAdar[candidatePath];
  if (!aaForCandidate) return 0;
  for (const seedPath of seedPaths) {
    const val = aaForCandidate[seedPath];
    if (val !== undefined && val > maxScore) maxScore = val;
  }
  return maxScore;
}

/** Type affinity: boost concept pages for conceptual queries. */
function scoreTypeAffinity(
  pageType: string,
  queryTerms: string[],
): number {
  const hasConceptIntent = queryTerms.some((t) => CONCEPT_INDICATORS.has(t));
  if (hasConceptIntent && pageType === "concept") return 1;
  if (!hasConceptIntent && pageType === "entity") return 0.5;
  return 0;
}

function isHistoricalCyclePage(relPath: string, title: string): boolean {
  return HISTORICAL_CYCLE_RE.test(`${relPath} ${title}`);
}

// ---------------------------------------------------------------------------
// Keyword matching (deterministic heuristic — no LLM)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function computeKeywordScore(
  terms: string[],
  title: string,
  tags: string[],
  body: string,
  relPath?: string,
): number {
  const lowerTitle = title.toLowerCase();
  const lowerTags = tags.map((t) => t.toLowerCase());
  const lowerBody = body.toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (lowerTitle.includes(term)) score += 3; // title match weighted highest
    if (lowerTags.some((t) => t.includes(term))) score += 2;
    if (lowerBody.includes(term)) score += 1;
  }
  if (relPath) score += pathSegmentBonus(terms, relPath);
  return score;
}

// ---------------------------------------------------------------------------
// Graph loading / building
// ---------------------------------------------------------------------------

async function loadOrBuildGraph(vault: string): Promise<GraphData | null> {
  const graphPath = join(vault, ".skillwiki", "graph.json");
  let needsBuild = false;

  try {
    const fileStat = await stat(graphPath);
    const ageHours = (Date.now() - fileStat.mtimeMs) / (1000 * 60 * 60);
    if (ageHours > 24) needsBuild = true;
  } catch {
    needsBuild = true;
  }

  if (needsBuild) {
    const buildResult = await runGraphBuild({ vault, out: graphPath });
    if (buildResult.exitCode !== 0) return null;
  }

  try {
    const raw = await readFile(graphPath, "utf8");
    return JSON.parse(raw) as GraphData;
  } catch {
    return null;
  }
}
