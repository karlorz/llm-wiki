import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
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
    const fm = extractFrontmatter(text);
    const split = splitFrontmatter(text);
    const title = fm.ok ? String(fm.data.title ?? "") : "";
    const body = split.ok ? split.data.body : text;
    tokenized.push({ path: page.relPath, tokens: tokenize(`${title} ${body}`) });
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
  await writeFile(dest, `${JSON.stringify(index)}\n`, "utf8");
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
