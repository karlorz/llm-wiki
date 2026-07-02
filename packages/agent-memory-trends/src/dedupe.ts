import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import yaml from "js-yaml";
import { normalizeCanonicalUrl } from "./config.js";
import type { SelectedGithubCandidate } from "./github.js";
import { err, ok, type Result } from "./types.js";

export interface ExistingTaskSignal {
  path: string;
  title: string;
  sourceUrl: string;
  repoName?: string;
}

export interface ActiveWorkSignal {
  path: string;
  title: string;
  status: "planned" | "in-progress";
  sourceUrls: string[];
  repoNames: string[];
}

export interface RecentDigestSignal {
  path: string;
  title: string;
  sourceUrls: string[];
  repoNames: string[];
}

export interface DedupeParseError {
  path: string;
  error: string;
}

export interface DuplicateSignals {
  existingTasks: ExistingTaskSignal[];
  activeWork: ActiveWorkSignal[];
  recentDigests: RecentDigestSignal[];
  parseErrors: DedupeParseError[];
}

export interface DuplicateDecision {
  duplicate: boolean;
  reasons: string[];
}

const ACTIVE_WORK_STATUSES = new Set(["planned", "in-progress"]);

export function collectDuplicateSignals(vault: string, project: string): Result<DuplicateSignals> {
  const parseErrors: DedupeParseError[] = [];
  try {
    return ok({
      existingTasks: collectExistingTasks(vault, project, parseErrors),
      activeWork: collectActiveWork(vault, project, parseErrors),
      recentDigests: collectRecentDigests(vault, parseErrors),
      parseErrors,
    });
  } catch (error) {
    return err("DEDUPE_SCAN_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export function evaluateDuplicateCandidate(candidate: SelectedGithubCandidate, signals: DuplicateSignals): DuplicateDecision {
  const reasons: string[] = [];
  const candidateUrl = normalizeCanonicalUrl(candidate.canonicalUrl);
  const candidateRepo = normalizeRepoName(candidate.fullName);
  const candidateTitles = [candidate.name, candidate.fullName.split("/").pop() ?? candidate.fullName].map(normalizeTitle);

  const taskByUrl = signals.existingTasks.find((task) => task.sourceUrl && normalizeCanonicalUrl(task.sourceUrl) === candidateUrl);
  if (taskByUrl) reasons.push(`duplicate source URL already captured in ${taskByUrl.path}`);

  const existingRepos = new Map<string, string>();
  for (const task of signals.existingTasks) {
    if (task.repoName) existingRepos.set(normalizeRepoName(task.repoName), task.path);
  }
  for (const work of signals.activeWork) {
    for (const repoName of work.repoNames) existingRepos.set(normalizeRepoName(repoName), work.path);
  }
  for (const digest of signals.recentDigests) {
    for (const repoName of digest.repoNames) existingRepos.set(normalizeRepoName(repoName), digest.path);
  }
  const repoMatch = existingRepos.get(candidateRepo);
  if (repoMatch) reasons.push(`duplicate repo name ${candidate.fullName} already appears in ${repoMatch}`);

  const titles = [
    ...signals.existingTasks.map((task) => ({ title: task.title, path: task.path })),
    ...signals.activeWork.map((work) => ({ title: work.title, path: work.path })),
  ];
  const titleMatch = titles.find((entry) => candidateTitles.some((title) => titlesAreNear(title, normalizeTitle(entry.title))));
  if (titleMatch) reasons.push(`near-title match with "${titleMatch.title}" in ${titleMatch.path}`);

  return { duplicate: reasons.length > 0, reasons };
}

function collectExistingTasks(vault: string, project: string, parseErrors: DedupeParseError[]): ExistingTaskSignal[] {
  const dir = join(vault, "raw", "transcripts");
  if (!existsSync(dir)) return [];
  const results: ExistingTaskSignal[] = [];
  for (const filePath of listMarkdownFiles(dir).filter((path) => /task/i.test(path))) {
    const parsed = tryReadMarkdownPage(vault, filePath, parseErrors);
    if (!parsed) continue;
    if (parsed.frontmatter.kind !== "task" || !frontmatterProjectMatches(parsed.frontmatter.project, project)) continue;
    const sourceUrl = stringValue(parsed.frontmatter.source_url);
    results.push({
      path: parsed.relPath,
      title: pageTitle(parsed, parsed.relPath),
      sourceUrl,
      repoName: repoNameFromText([sourceUrl, parsed.body].join("\n")),
    });
  }
  return results;
}

function collectActiveWork(vault: string, project: string, parseErrors: DedupeParseError[]): ActiveWorkSignal[] {
  const dir = join(vault, "projects", project, "work");
  if (!existsSync(dir)) return [];
  const results: ActiveWorkSignal[] = [];
  for (const filePath of listMarkdownFiles(dir).filter((path) => path.endsWith("/spec.md"))) {
    const parsed = tryReadMarkdownPage(vault, filePath, parseErrors);
    if (!parsed) continue;
    if (!ACTIVE_WORK_STATUSES.has(stringValue(parsed.frontmatter.status))) continue;
    const sourceUrls = extractUrls([stringValue(parsed.frontmatter.source_url), parsed.body].join("\n"));
    results.push({
      path: parsed.relPath,
      title: pageTitle(parsed, parsed.relPath),
      status: stringValue(parsed.frontmatter.status) as "planned" | "in-progress",
      sourceUrls,
      repoNames: unique(sourceUrls.map(repoNameFromGithubUrl).filter(isString).concat(extractRepoNames(parsed.body))),
    });
  }
  return results;
}

function collectRecentDigests(vault: string, parseErrors: DedupeParseError[]): RecentDigestSignal[] {
  const dir = join(vault, "queries");
  if (!existsSync(dir)) return [];
  const results: RecentDigestSignal[] = [];
  for (const filePath of listMarkdownFiles(dir)
    .filter((path) => /agent-memory-trends-digest/i.test(path))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 30)) {
    const parsed = tryReadMarkdownPage(vault, filePath, parseErrors);
    if (!parsed) continue;
    const sourceUrls = extractUrls([stringValue(parsed.frontmatter.source_url), parsed.body].join("\n"));
    results.push({
      path: parsed.relPath,
      title: pageTitle(parsed, parsed.relPath),
      sourceUrls,
      repoNames: unique(sourceUrls.map(repoNameFromGithubUrl).filter(isString).concat(extractRepoNames(parsed.body))),
    });
  }
  return results;
}

interface ParsedPage {
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

function tryReadMarkdownPage(vault: string, path: string, parseErrors: DedupeParseError[]): ParsedPage | null {
  try {
    return readMarkdownPage(vault, path);
  } catch (error) {
    const absolutePath = path.startsWith(vault) ? path : join(vault, path);
    parseErrors.push({
      path: relative(vault, absolutePath),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function readMarkdownPage(vault: string, path: string): ParsedPage {
  const absolutePath = path.startsWith(vault) ? path : join(vault, path);
  const relPath = relative(vault, absolutePath);
  const text = readFileSync(absolutePath, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { relPath, frontmatter: {}, body: text };
  const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { relPath, frontmatter, body: match[2] ?? "" };
}

function listMarkdownFiles(dir: string): string[] {
  const entries = readdirSync(dir).map((entry) => join(dir, entry));
  const files: string[] = [];
  for (const entry of entries) {
    const stats = statSync(entry);
    if (stats.isDirectory()) files.push(...listMarkdownFiles(entry));
    else if (stats.isFile() && entry.endsWith(".md")) files.push(entry);
  }
  return files;
}

function frontmatterProjectMatches(value: unknown, project: string): boolean {
  if (typeof value !== "string") return false;
  return value === `[[${project}]]` || value === project;
}

function pageTitle(parsed: ParsedPage, path: string): string {
  return stringValue(parsed.frontmatter.title) || path.split("/").pop()?.replace(/\.md$/, "") || path;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractUrls(text: string): string[] {
  return unique([...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)].map((match) => normalizeCanonicalUrl(match[0])));
}

function repoNameFromText(text: string): string | undefined {
  return repoNameFromGithubUrl(extractUrls(text)[0] ?? "");
}

function repoNameFromGithubUrl(url: string): string | undefined {
  const normalized = normalizeCanonicalUrl(url);
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1];
}

function extractRepoNames(text: string): string[] {
  return unique(
    [...text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)]
      .map((match) => normalizeRepoName(match[1] ?? ""))
      .filter((name) => name.includes("/"))
  );
}

function normalizeRepoName(name: string): string {
  return name.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/+$/, "").toLowerCase();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titlesAreNear(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 && intersection / union >= 0.8;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}