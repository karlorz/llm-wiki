import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault, readPage } from "../utils/vault.js";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { runGraphBuild } from "./graph.js";

export interface QueryInput {
  text: string;
  vault: string;
  limit?: number;
}

export interface QueryResult {
  path: string;
  score: number;
  title: string;
  type: string;
}

export interface QueryOutput {
  results: QueryResult[];
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

// Conceptual query indicators for type affinity signal
const CONCEPT_INDICATORS = new Set([
  "what", "how", "why", "concept", "idea", "pattern", "principle",
  "theory", "approach", "method", "framework", "model", "definition",
]);

export async function runQuery(
  input: QueryInput,
): Promise<{ exitCode: number; result: Result<QueryOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const limit = input.limit ?? 10;
  const queryTerms = tokenize(input.text);

  if (queryTerms.length === 0) {
    return {
      exitCode: ExitCode.OK,
      result: ok({ results: [], humanHint: "no query terms" }),
    };
  }

  // Load or build graph (builds if missing or stale > 24h)
  const graph = await loadOrBuildGraph(input.vault);

  // Load page data and compute keyword scores
  interface PageData {
    relPath: string;
    title: string;
    type: string;
    tags: string[];
    sources: string[];
    keywordScore: number;
  }

  const pages: PageData[] = [];
  for (const p of scan.data.typedKnowledge) {
    const text = await readPage(p);
    const fm = extractFrontmatter(text);
    if (!fm.ok) continue;

    const title = String(fm.data.title ?? "");
    const type = String(fm.data.type ?? "");
    const tags = Array.isArray(fm.data.tags)
      ? fm.data.tags.map(String)
      : [];
    const sources = Array.isArray(fm.data.sources)
      ? fm.data.sources.map(String)
      : [];

    const split = splitFrontmatter(text);
    const body = split.ok ? split.data.body : text;

    const keywordScore = computeKeywordScore(queryTerms, title, tags, body);
    pages.push({ relPath: p.relPath, title, type, tags, sources, keywordScore });
  }

  // Identify seed pages — those with direct keyword match
  const seedPaths = new Set(
    pages.filter((p) => p.keywordScore > 0).map((p) => p.relPath),
  );

  // Composite scoring with 4 signals
  // Seed pages (keyword match > 0) always rank above non-seed pages
  // because non-seed structural signals are discounted by NON_SEED_FACTOR.
  const results: QueryResult[] = pages
    .map((page) => {
      const sourceOverlap = scoreSourceOverlap(page, pages, seedPaths);
      const wikilink = scoreWikilink(page.relPath, seedPaths, graph);
      const aa = scoreAdamicAdar(page.relPath, seedPaths, graph);
      const typeAffinity = scoreTypeAffinity(page.type, queryTerms);
      const isSeed = page.keywordScore > 0;

      const structuralBoost =
        sourceOverlap * W_SOURCE_OVERLAP +
        wikilink * W_WIKILINK +
        aa * W_ADAMIC_ADAR;

      const composite = isSeed
        ? page.keywordScore * W_KEYWORD + structuralBoost + typeAffinity * W_TYPE_AFFINITY
        : structuralBoost * NON_SEED_FACTOR + typeAffinity * W_TYPE_AFFINITY;

      return {
        path: page.relPath,
        score: Math.round(composite * 1000) / 1000,
        title: page.title,
        type: page.type,
      };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);

  const humanHint =
    results.length === 0
      ? "no matching pages found"
      : results.map((r) => `${r.path} (score: ${r.score})`).join("\n");

  return { exitCode: ExitCode.OK, result: ok({ results, humanHint }) };
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Source overlap: count shared raw sources between this page and seed pages. */
function scoreSourceOverlap(
  page: { relPath: string; sources: string[] },
  allPages: { relPath: string; sources: string[]; keywordScore: number }[],
  seedPaths: Set<string>,
): number {
  if (page.sources.length === 0) return 0;
  let total = 0;
  for (const seed of allPages) {
    if (seed.relPath === page.relPath || !seedPaths.has(seed.relPath)) continue;
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
