import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { err, ok, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { atomicWriteText } from "./atomic-write.js";
import { readPage, scanVault } from "./vault.js";

export const VECTOR_INDEX_REL = ".skillwiki/vectors/index.json";
export const VECTOR_INDEX_SCHEMA = "skillwiki-tfidf-index/v1";

export interface VectorIndex {
  schema: typeof VECTOR_INDEX_SCHEMA;
  built_at: string;
  page_count: number;
  df: Record<string, number>;
  docs: Record<string, Record<string, number>>;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function extractPageTokens(text: string): string[] {
  const fm = extractFrontmatter(text);
  const split = splitFrontmatter(text);
  const title = fm.ok ? String(fm.data.title ?? "") : "";
  const body = split.ok ? split.data.body : text;
  return tokenize(`${title} ${body}`);
}

export function vectorIndexPath(vault: string): string {
  return join(vault, ...VECTOR_INDEX_REL.split("/"));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
  return tf;
}

function toTfIdf(tf: Map<string, number>, df: Record<string, number>, docs: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [term, count] of tf) {
    const appears = df[term] ?? 0;
    if (appears === 0) continue;
    out[term] = (count / Math.max(1, tf.size)) * Math.log((docs + 1) / appears);
  }
  return out;
}

function cosine(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const value of Object.values(a)) na += value * value;
  for (const value of Object.values(b)) nb += value * value;
  if (na === 0 || nb === 0) return 0;
  const shorter = Object.keys(a).length < Object.keys(b).length ? a : b;
  const longer = shorter === a ? b : a;
  for (const [term, value] of Object.entries(shorter)) {
    const other = longer[term];
    if (other) dot += value * other;
  }
  return dot / Math.sqrt(na * nb);
}

export async function buildVectorIndex(vault: string, now = new Date().toISOString()): Promise<Result<VectorIndex>> {
  const scan = await scanVault(vault);
  if (!scan.ok) return scan;
  const tokenized: Array<{ path: string; tokens: string[] }> = [];
  for (const page of scan.data.typedKnowledge) {
    const text = await readPage(page);
    tokenized.push({ path: page.relPath, tokens: extractPageTokens(text) });
  }
  const df: Record<string, number> = {};
  for (const doc of tokenized) {
    for (const term of new Set(doc.tokens)) df[term] = (df[term] ?? 0) + 1;
  }
  const docs: Record<string, Record<string, number>> = {};
  for (const doc of tokenized) {
    docs[doc.path] = toTfIdf(termFreq(doc.tokens), df, tokenized.length);
  }
  const index: VectorIndex = {
    schema: VECTOR_INDEX_SCHEMA,
    built_at: now,
    page_count: tokenized.length,
    df,
    docs,
  };
  const dest = vectorIndexPath(vault);
  await mkdir(join(vault, ".skillwiki", "vectors"), { recursive: true });
  await atomicWriteText(dest, `${JSON.stringify(index)}\n`);
  return ok(index);
}

export async function loadVectorIndex(vault: string): Promise<Result<VectorIndex>> {
  try {
    const raw = await readFile(vectorIndexPath(vault), "utf8");
    const parsed = JSON.parse(raw) as VectorIndex;
    if (parsed.schema !== VECTOR_INDEX_SCHEMA || typeof parsed.docs !== "object" || parsed.docs === null) {
      return err("HYBRID_INDEX_INVALID", { path: VECTOR_INDEX_REL });
    }
    return ok(parsed);
  } catch {
    return err("HYBRID_INDEX_MISSING", { path: VECTOR_INDEX_REL, message: "run skillwiki vectors rebuild" });
  }
}

export async function vectorIndexStatus(vault: string): Promise<Result<{ path: string; present: boolean; page_count?: number; built_at?: string; age_hours?: number }>> {
  const path = vectorIndexPath(vault);
  try {
    const fileStat = await stat(path);
    const loaded = await loadVectorIndex(vault);
    if (!loaded.ok) return ok({ path: VECTOR_INDEX_REL, present: false });
    return ok({
      path: VECTOR_INDEX_REL,
      present: true,
      page_count: loaded.data.page_count,
      built_at: loaded.data.built_at,
      age_hours: (Date.now() - fileStat.mtimeMs) / 3_600_000,
    });
  } catch {
    return ok({ path: VECTOR_INDEX_REL, present: false });
  }
}

export function rankVectorIndex(index: VectorIndex, query: string): string[] {
  const q = toTfIdf(termFreq(tokenize(query)), index.df, Math.max(1, index.page_count));
  return Object.entries(index.docs)
    .map(([path, vector]) => ({ path, score: cosine(q, vector) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .map((row) => row.path);
}

export interface ReindexPageResult {
  path: string;
  page: string;
  terms_added: number;
  terms_removed: number;
  page_count: number;
}

export async function reindexPageInVectorIndex(
  vault: string,
  pageRelPath: string,
  now = new Date().toISOString(),
): Promise<Result<ReindexPageResult>> {
  const normalizedPage = pageRelPath.split(/\\|\//).join("/");
  if (!normalizedPage.endsWith(".md")) {
    return err("USAGE", { message: `Page must be a .md file: ${pageRelPath}` });
  }

  const absPath = join(vault, ...normalizedPage.split("/"));
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    return err("FILE_NOT_FOUND", { path: normalizedPage });
  }

  const loaded = await loadVectorIndex(vault);
  if (!loaded.ok) return loaded;
  const index = loaded.data;

  const tokens = extractPageTokens(text);
  const newTf = termFreq(tokens);
  const newTerms = new Set(newTf.keys());

  const oldDoc = index.docs[normalizedPage];
  const oldTerms = oldDoc ? new Set(Object.keys(oldDoc)) : new Set<string>();

  const isNewPage = !oldDoc;
  const newPageCount = isNewPage ? index.page_count + 1 : index.page_count;

  const termsAdded: string[] = [];
  const termsRemoved: string[] = [];

  for (const t of newTerms) {
    if (!oldTerms.has(t)) termsAdded.push(t);
  }
  for (const t of oldTerms) {
    if (!newTerms.has(t)) termsRemoved.push(t);
  }

  const dfChangedTerms = new Set<string>();

  // If new page was added, ALL terms in the entire index have their IDF affected because page_count changed!
  // If page count did not change, only terms whose df changed have their IDF affected.
  for (const t of termsAdded) {
    index.df[t] = (index.df[t] ?? 0) + 1;
    dfChangedTerms.add(t);
  }
  for (const t of termsRemoved) {
    const nextDf = (index.df[t] ?? 1) - 1;
    if (nextDf <= 0) {
      delete index.df[t];
    } else {
      index.df[t] = nextDf;
    }
    dfChangedTerms.add(t);
  }

  index.page_count = newPageCount;
  index.built_at = now;

  // Recompute stored tfidf scores:
  // 1. For target page:
  index.docs[normalizedPage] = toTfIdf(newTf, index.df, index.page_count);

  // 2. For every other doc:
  if (isNewPage) {
    // page_count changed -> idf changed for every term, so all docs need recomputation
    // We can rescore every other doc using its existing stored scores adjusted by new IDF / old IDF
    const oldDocsTotal = newPageCount - 1;
    for (const [docPath, docVector] of Object.entries(index.docs)) {
      if (docPath === normalizedPage) continue;
      const updatedVector: Record<string, number> = {};
      for (const [term, oldScore] of Object.entries(docVector)) {
        const dfVal = index.df[term];
        if (!dfVal || dfVal <= 0) continue;
        // Old IDF was log((oldDocsTotal + 1) / oldDf)
        // Note: oldDf for term is index.df[term] unless term was in termsAdded (which had oldDf = index.df[term] - 1)
        const oldDf = termsAdded.includes(term) ? index.df[term] - 1 : index.df[term];
        const oldIdf = Math.log((oldDocsTotal + 1) / oldDf);
        const newIdf = Math.log((newPageCount + 1) / dfVal);
        updatedVector[term] = oldIdf !== 0 ? oldScore * (newIdf / oldIdf) : 0;
      }
      index.docs[docPath] = updatedVector;
    }
  } else if (dfChangedTerms.size > 0) {
    // page_count is same. For any other doc containing a term in dfChangedTerms:
    for (const [docPath, docVector] of Object.entries(index.docs)) {
      if (docPath === normalizedPage) continue;
      let touched = false;
      for (const t of Object.keys(docVector)) {
        if (dfChangedTerms.has(t)) {
          touched = true;
          break;
        }
      }
      if (!touched) continue;

      const updatedVector: Record<string, number> = {};
      for (const [term, oldScore] of Object.entries(docVector)) {
        const dfVal = index.df[term];
        if (!dfVal || dfVal <= 0) continue;
        if (dfChangedTerms.has(term)) {
          // Old df: if term in termsAdded, oldDf = dfVal - 1; if term in termsRemoved, oldDf = dfVal + 1
          const oldDf = termsAdded.includes(term) ? dfVal - 1 : termsRemoved.includes(term) ? dfVal + 1 : dfVal;
          const oldIdf = Math.log((newPageCount + 1) / oldDf);
          const newIdf = Math.log((newPageCount + 1) / dfVal);
          updatedVector[term] = oldIdf !== 0 ? oldScore * (newIdf / oldIdf) : 0;
        } else {
          updatedVector[term] = oldScore;
        }
      }
      index.docs[docPath] = updatedVector;
    }
  }

  const dest = vectorIndexPath(vault);
  await mkdir(join(vault, ".skillwiki", "vectors"), { recursive: true });
  await atomicWriteText(dest, `${JSON.stringify(index)}\n`);

  return ok({
    path: VECTOR_INDEX_REL,
    page: normalizedPage,
    terms_added: termsAdded.length,
    terms_removed: termsRemoved.length,
    page_count: index.page_count,
  });
}

export interface PruneVectorIndexResult {
  path: string;
  orphans: string[];
  removed: number;
  page_count: number;
  terms_pruned: number;
}

export interface PruneVectorIndexOptions {
  dryRun?: boolean;
  now?: string;
}

export async function pruneVectorIndex(
  vault: string,
  opts?: PruneVectorIndexOptions,
): Promise<Result<PruneVectorIndexResult>> {
  const loaded = await loadVectorIndex(vault);
  if (!loaded.ok) return loaded;
  const index = loaded.data;

  const orphans: string[] = [];
  for (const docKey of Object.keys(index.docs)) {
    const normalizedKey = docKey.split(/\\|\//).join("/");
    const absPath = join(vault, ...normalizedKey.split("/"));
    if (!existsSync(absPath)) {
      orphans.push(normalizedKey);
    }
  }

  if (orphans.length === 0) {
    return ok({
      path: VECTOR_INDEX_REL,
      orphans: [],
      removed: 0,
      page_count: index.page_count,
      terms_pruned: 0,
    });
  }

  const oldPageCount = index.page_count;
  const newPageCount = Math.max(0, oldPageCount - orphans.length);

  // For df tracking: collect terms from all orphaned docs
  let termsPrunedCount = 0;
  for (const orphanKey of orphans) {
    const orphanDoc = index.docs[orphanKey] ?? {};
    for (const term of Object.keys(orphanDoc)) {
      const nextDf = (index.df[term] ?? 1) - 1;
      if (nextDf <= 0) {
        delete index.df[term];
        termsPrunedCount++;
      } else {
        index.df[term] = nextDf;
      }
    }
    delete index.docs[orphanKey];
  }

  index.page_count = newPageCount;
  const now = opts?.now ?? new Date().toISOString();
  index.built_at = now;

  // Scan remaining docs and re-read their text to calculate exact TF and recompute toTfIdf
  const scan = await scanVault(vault);
  if (!scan.ok) return scan;

  const remainingPagesByRel = new Map<string, typeof scan.data.typedKnowledge[number]>();
  for (const p of scan.data.typedKnowledge) {
    remainingPagesByRel.set(p.relPath, p);
  }

  for (const docKey of Object.keys(index.docs)) {
    const page = remainingPagesByRel.get(docKey);
    if (page) {
      const text = await readPage(page);
      const tokens = extractPageTokens(text);
      index.docs[docKey] = toTfIdf(termFreq(tokens), index.df, newPageCount);
    } else {
      // If docKey is not in typedKnowledge (e.g. if scan didn't find it or different category),
      // we remove or keep? But orphans check already checked existsSync. If it exists but not in typedKnowledge:
      try {
        const text = await readFile(join(vault, ...docKey.split("/")), "utf8");
        const tokens = extractPageTokens(text);
        index.docs[docKey] = toTfIdf(termFreq(tokens), index.df, newPageCount);
      } catch {
        delete index.docs[docKey];
      }
    }
  }

  if (!opts?.dryRun) {
    const dest = vectorIndexPath(vault);
    await mkdir(join(vault, ".skillwiki", "vectors"), { recursive: true });
    await atomicWriteText(dest, `${JSON.stringify(index)}\n`);
  }

  return ok({
    path: VECTOR_INDEX_REL,
    orphans,
    removed: orphans.length,
    page_count: newPageCount,
    terms_pruned: termsPrunedCount,
  });
}

