import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { err, ok, ExitCode, type Result } from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { readPage, scanVault, type VaultPage } from "../utils/vault.js";
import { redactSensitiveContent } from "../utils/sensitive-content.js";
import { runValidate } from "./validate.js";

export interface MemoryTopicsInput {
  vault: string;
  project?: string;
  limit?: number;
}

export interface MemoryIndexInput {
  vault: string;
  project: string;
  check?: boolean;
  ifStale?: boolean;
}

export type MemoryRecallScope = "project" | "global" | "cross-agent" | "all";

export interface MemoryRecallInput {
  vault: string;
  project: string;
  topic: string;
  limit?: number;
  scope?: MemoryRecallScope | string;
}

export interface MemoryReviewInput {
  vault: string;
  project: string;
  dryRun?: boolean;
  preAction?: string;
}

export interface MemoryImportInput {
  vault: string;
  from: string;
  project: string;
  apply?: boolean;
  maxBytes?: number;
}

export interface MemoryTopic {
  name: string;
  summary: string;
  project?: string;
  updated: string;
  paths: string[];
}

export interface MemorySource {
  path: string;
  title: string;
  summary: string;
  updated: string;
  hash: string;
  topics: string[];
  project?: string;
  memory_kind?: string;
  memory_scope?: string;
  memory_policy?: string;
  memory_privacy: string;
  memory_status: string;
}

export interface MemoryTopicsOutput {
  generated_at?: string;
  cache_present: boolean;
  topics: MemoryTopic[];
  files_written: string[];
  humanHint: string;
}

export interface MemoryIndexOutput {
  project: string;
  generated_at?: string;
  cache_present?: boolean;
  stale?: boolean;
  topic_count: number;
  source_count: number;
  drift?: MemoryIndexDrift;
  topics: MemoryTopic[];
  files_written: string[];
  warnings: string[];
  humanHint: string;
}

export interface MemoryRecallOutput {
  project: string;
  topic: string;
  scope?: MemoryRecallScope;
  sources: MemorySource[];
  humanHint: string;
}

export type MemoryReviewSeverity = "info" | "warn";

export type MemoryReviewFindingKind =
  | "cache_missing"
  | "cache_stale"
  | "source_hash_drift"
  | "invalid_topic_slug"
  | "metadata_gap"
  | "sparse_topic"
  | "scope_gap"
  | "consolidation_candidate"
  | "past_failure_match";

export interface MemoryReviewFinding {
  id: string;
  severity: MemoryReviewSeverity;
  kind: MemoryReviewFindingKind;
  path?: string;
  topic?: string;
  message: string;
  suggested_action: string;
}

export interface MemoryReviewOutput {
  project: string;
  generated_at: string;
  cache: {
    present: boolean;
    generated_at?: string;
    stale: boolean;
    source_hash_mismatches: string[];
  };
  findings: MemoryReviewFinding[];
  files_written: string[];
  humanHint: string;
}

export interface MemoryIndexDrift {
  missing_sources: string[];
  removed_sources: string[];
  changed_sources: string[];
}

export type MemoryImportStatus = "ready" | "written" | "rejected";

export interface MemoryImportEntry {
  source_path: string;
  source_kind: string;
  sha256: string;
  status: MemoryImportStatus;
  reason?: string;
  memory_kind: string;
  memory_privacy: string;
  redaction_count: number;
  proposed_path?: string;
  written_path?: string;
  validation?: {
    valid: boolean;
    exit_code: number;
  };
}

export interface MemoryImportManifest {
  project: string;
  generated_at: string;
  source_root: string;
  entries: MemoryImportEntry[];
}

export interface MemoryImportOutput {
  applied: boolean;
  manifest: MemoryImportManifest;
  files_written: string[];
  humanHint: string;
}

interface MemoryTopicsCache {
  generated_at?: unknown;
  project?: unknown;
  topics?: unknown;
  sources?: unknown;
}

export async function runMemoryTopics(
  input: MemoryTopicsInput
): Promise<{ exitCode: number; result: Result<MemoryTopicsOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const cacheText = await readMemoryCache(input.vault, input.project);
  if (!cacheText) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        cache_present: false,
        topics: [],
        files_written: [],
        humanHint: "no memory topics cache found",
      }),
    };
  }

  let parsed: MemoryTopicsCache;
  try {
    parsed = JSON.parse(cacheText) as MemoryTopicsCache;
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", {
        path: ".skillwiki/memory-topics.json",
        message: `invalid memory topics cache: ${String(e)}`,
      }),
    };
  }

  const limit = normalizeLimit(input.limit);
  const topics = normalizeTopics(parsed.topics)
    .filter((topic) => !input.project || topic.project === input.project)
    .sort(compareTopics)
    .slice(0, limit);

  return {
    exitCode: ExitCode.OK,
    result: ok({
      generated_at: stringField(parsed.generated_at) || undefined,
      cache_present: true,
      topics,
      files_written: [],
      humanHint: renderHumanHint(topics),
    }),
  };
}

export async function runMemoryIndex(
  input: MemoryIndexInput
): Promise<{ exitCode: number; result: Result<MemoryIndexOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const state = await buildMemoryIndexState(scan.data.allMarkdown, input.project);
  let status: MemoryIndexStatus | undefined;
  if (input.check || input.ifStale) {
    const checked = await checkMemoryIndex(input.vault, input.project, state);
    if (!checked.ok) return checked.error;
    status = checked.data;

    if (input.check || !status.stale) {
      return {
        exitCode: ExitCode.OK,
        result: ok({
          ...status,
          files_written: [],
          warnings: state.warnings,
          humanHint: renderMemoryIndexStatusHint(status),
        }),
      };
    }
  }

  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const relCachePath = memoryCacheRelPath(input.project);
  const absCachePath = join(input.vault, relCachePath);

  await mkdir(join(input.vault, ".skillwiki", "memory", input.project), { recursive: true });
  await writeFile(absCachePath, `${JSON.stringify({
    generated_at: generatedAt,
    project: input.project,
    topics: state.topics,
    sources: state.sources,
    warnings: state.warnings,
  }, null, 2)}\n`, "utf8");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      project: input.project,
      generated_at: generatedAt,
      cache_present: status?.cache_present ?? true,
      stale: status?.stale ?? false,
      drift: status?.drift ?? emptyMemoryIndexDrift(),
      topic_count: state.topics.length,
      source_count: state.sources.length,
      topics: state.topics,
      files_written: [relCachePath],
      warnings: state.warnings,
      humanHint: `indexed ${state.sources.length} memory sources into ${state.topics.length} topics for ${input.project}`,
    }),
  };
}

export async function runMemoryRecall(
  input: MemoryRecallInput
): Promise<{ exitCode: number; result: Result<MemoryRecallOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const scope = normalizeRecallScope(input.scope);
  if (input.scope && !scope) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", {
        path: "memory recall --scope",
        message: `invalid memory recall scope: ${String(input.scope)}`,
      }),
    };
  }

  const cacheText = await readMemoryCache(input.vault, input.project);
  if (!cacheText) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        project: input.project,
        topic: input.topic,
        ...(scope ? { scope } : {}),
        sources: [],
        humanHint: `no memory topics cache found for project ${input.project}`,
      }),
    };
  }

  let parsed: MemoryTopicsCache;
  try {
    parsed = JSON.parse(cacheText) as MemoryTopicsCache;
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", {
        path: memoryCacheRelPath(input.project),
        message: `invalid memory topics cache: ${String(e)}`,
      }),
    };
  }

  const limit = normalizeLimit(input.limit);
  const sources = normalizeSources(parsed.sources)
    .filter((source) => source.topics.includes(input.topic))
    .filter((source) => source.memory_privacy !== "secret-blocked")
    .filter((source) => source.memory_status !== "archived" && source.memory_status !== "rejected")
    .filter((source) => recallScopeMatches(source, input.project, scope))
    .sort((a, b) => compareRecallSources(a, b, input.project, scope))
    .slice(0, limit);

  return {
    exitCode: ExitCode.OK,
    result: ok({
      project: input.project,
      topic: input.topic,
      ...(scope ? { scope } : {}),
      sources,
      humanHint: renderRecallHint(input.topic, sources),
    }),
  };
}

export async function runMemoryReview(
  input: MemoryReviewInput
): Promise<{ exitCode: number; result: Result<MemoryReviewOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const state = await buildMemoryIndexState(scan.data.allMarkdown, input.project);
  const checked = await checkMemoryIndex(input.vault, input.project, state);
  if (!checked.ok) {
    return {
      exitCode: checked.error.exitCode,
      result: checked.error.result as unknown as Result<MemoryReviewOutput>,
    };
  }

  const findings = buildMemoryReviewFindings({
    project: input.project,
    status: checked.data,
    indexState: state,
    reviewPages: state.reviewPages,
  });
  const preAction = input.preAction?.trim();
  if (preAction) {
    findings.push(...await buildPastFailureFindings(scan.data.allMarkdown, input.project, preAction));
    findings.sort(compareMemoryReviewFindings);
  }
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      project: input.project,
      generated_at: generatedAt,
      cache: {
        present: checked.data.cache_present,
        ...(checked.data.generated_at ? { generated_at: checked.data.generated_at } : {}),
        stale: checked.data.stale,
        source_hash_mismatches: checked.data.drift.changed_sources,
      },
      findings,
      files_written: [],
      humanHint: renderMemoryReviewHint(input.project, checked.data, findings),
    }),
  };
}

export async function runMemoryImport(
  input: MemoryImportInput
): Promise<{ exitCode: number; result: Result<MemoryImportOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const maxBytes = input.maxBytes ?? 200_000;
  let files: string[];
  try {
    files = await collectImportFiles(input.from);
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { path: input.from, message: String(e) }),
    };
  }
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = generatedAt.slice(0, 10);
  const entries: MemoryImportEntry[] = [];
  const filesWritten: string[] = [];

  for (const file of files) {
    let entry: MemoryImportEntry;
    try {
      entry = await buildImportEntry(file, input.from, input.project, today, maxBytes);
      if (input.apply && entry.status === "ready" && entry.proposed_path) {
        const written = await writeImportCapture(input.vault, entry, today);
        entry.status = "written";
        entry.written_path = written.relPath;
        entry.validation = written.validation;
        filesWritten.push(written.relPath);
      }
    } catch (e: unknown) {
      return {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", { path: file, message: String(e) }),
      };
    }
    entries.push(entry);
  }

  const manifest: MemoryImportManifest = {
    project: input.project,
    generated_at: generatedAt,
    source_root: input.from,
    entries,
  };

  const ready = entries.filter((entry) => entry.status === "ready").length;
  const written = entries.filter((entry) => entry.status === "written").length;
  const rejected = entries.filter((entry) => entry.status === "rejected").length;

  return {
    exitCode: ExitCode.OK,
    result: ok({
      applied: !!input.apply,
      manifest,
      files_written: filesWritten,
      humanHint: input.apply
        ? `memory import applied: ${written} written, ${rejected} rejected`
        : `memory import dry-run: ${ready} ready, ${rejected} rejected`,
    }),
  };
}

interface MemoryIndexState {
  topics: MemoryTopic[];
  sources: MemorySource[];
  warnings: string[];
  reviewPages: MemoryReviewPage[];
}

interface MemoryIndexStatus extends MemoryIndexOutput {
  cache_present: boolean;
  stale: boolean;
  drift: MemoryIndexDrift;
  files_written: string[];
  warnings: string[];
}

interface MemoryReviewPage {
  path: string;
  metadataGaps: string[];
}

type MemoryIndexCheckResult =
  | { ok: true; data: MemoryIndexStatus }
  | { ok: false; error: { exitCode: number; result: Result<MemoryIndexOutput> } };

async function buildMemoryIndexState(pages: VaultPage[], project: string): Promise<MemoryIndexState> {
  const warnings: string[] = [];
  const sourcePages = dedupePages(pages);
  const sources: MemorySource[] = [];
  const reviewPages: MemoryReviewPage[] = [];

  for (const page of sourcePages) {
    const memoryPage = await readMemoryPage(page, project, warnings);
    if (!memoryPage) continue;
    sources.push(memoryPage.source);
    if (memoryPage.reviewPage) reviewPages.push(memoryPage.reviewPage);
  }

  return {
    sources,
    topics: buildTopics(project, sources),
    warnings,
    reviewPages,
  };
}

async function checkMemoryIndex(
  vault: string,
  project: string,
  current: MemoryIndexState
): Promise<MemoryIndexCheckResult> {
  const relCachePath = memoryCacheRelPath(project);
  const cacheText = await readIfExists(join(vault, relCachePath));
  if (!cacheText) {
    return {
      ok: true,
      data: {
        project,
        cache_present: false,
        stale: true,
        topic_count: current.topics.length,
        source_count: current.sources.length,
        topics: current.topics,
        drift: emptyMemoryIndexDrift(),
        files_written: [],
        warnings: current.warnings,
        humanHint: "",
      },
    };
  }

  let parsed: MemoryTopicsCache;
  try {
    parsed = JSON.parse(cacheText) as MemoryTopicsCache;
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", {
          path: relCachePath,
          message: `invalid memory topics cache: ${String(e)}`,
        }),
      },
    };
  }

  const cachedSources = normalizeSources(parsed.sources);
  const cachedTopics = normalizeTopics(parsed.topics);
  const drift = compareMemorySources(current.sources, cachedSources);
  const stale = drift.missing_sources.length > 0
    || drift.removed_sources.length > 0
    || drift.changed_sources.length > 0
    || !sameStringSet(current.topics.map((topic) => topic.name), cachedTopics.map((topic) => topic.name));

  return {
    ok: true,
    data: {
      project,
      generated_at: stringField(parsed.generated_at) || undefined,
      cache_present: true,
      stale,
      topic_count: current.topics.length,
      source_count: current.sources.length,
      topics: current.topics,
      drift,
      files_written: [],
      warnings: current.warnings,
      humanHint: "",
    },
  };
}

function compareMemorySources(current: MemorySource[], cached: MemorySource[]): MemoryIndexDrift {
  const currentByPath = new Map(current.map((source) => [source.path, source]));
  const cachedByPath = new Map(cached.map((source) => [source.path, source]));
  const missing_sources = current
    .filter((source) => !cachedByPath.has(source.path))
    .map((source) => source.path)
    .sort((a, b) => a.localeCompare(b));
  const removed_sources = cached
    .filter((source) => !currentByPath.has(source.path))
    .map((source) => source.path)
    .sort((a, b) => a.localeCompare(b));
  const changed_sources = current
    .filter((source) => {
      const cachedSource = cachedByPath.get(source.path);
      return !!cachedSource && !sameMemorySource(source, cachedSource);
    })
    .map((source) => source.path)
    .sort((a, b) => a.localeCompare(b));
  return { missing_sources, removed_sources, changed_sources };
}

function sameMemorySource(a: MemorySource, b: MemorySource): boolean {
  return a.hash === b.hash
    && a.updated === b.updated
    && (a.project ?? "") === (b.project ?? "")
    && (a.memory_kind ?? "") === (b.memory_kind ?? "")
    && (a.memory_scope ?? "") === (b.memory_scope ?? "")
    && (a.memory_policy ?? "") === (b.memory_policy ?? "")
    && a.memory_privacy === b.memory_privacy
    && a.memory_status === b.memory_status
    && sameStringSet(a.topics, b.topics);
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x.localeCompare(y));
  const right = [...b].sort((x, y) => x.localeCompare(y));
  return left.every((value, index) => value === right[index]);
}

function emptyMemoryIndexDrift(): MemoryIndexDrift {
  return {
    missing_sources: [],
    removed_sources: [],
    changed_sources: [],
  };
}

async function readMemoryPage(
  page: VaultPage,
  project: string,
  warnings: string[]
): Promise<{ source: MemorySource; reviewPage?: MemoryReviewPage } | null> {
  const text = await readPage(page);
  const fm = extractFrontmatter(text);
  if (!fm.ok) return null;

  const rawTopics = typeof fm.data.memory_topics === "string"
    ? [fm.data.memory_topics]
    : stringArray(fm.data.memory_topics);
  if (rawTopics.length === 0) return null;

  const topics = normalizeMemoryTopics(fm.data.memory_topics, page.relPath, warnings);
  if (topics.length === 0) return null;

  const scope = stringField(fm.data.memory_scope);
  const projects = memoryProjects(page.relPath, fm.data);
  if (!projects.includes(project) && scope !== "global" && scope !== "cross-agent") return null;

  const privacy = stringField(fm.data.memory_privacy) || "local";
  if (privacy === "secret-blocked") {
    warnings.push(`${page.relPath}: skipped secret-blocked memory`);
    return null;
  }

  const status = stringField(fm.data.memory_status) || "active";
  if (status === "archived" || status === "rejected") return null;

  const metadataGaps: string[] = [];
  if (!scope) metadataGaps.push("memory_scope");
  if (!stringField(fm.data.memory_policy)) metadataGaps.push("memory_policy");
  if (!stringField(fm.data.memory_privacy)) metadataGaps.push("memory_privacy");
  if (!stringField(fm.data.memory_status)) metadataGaps.push("memory_status");
  if (!stringField(fm.data.last_seen) && !stringField(fm.data.updated) && !stringField(fm.data.ingested)) {
    metadataGaps.push("freshness");
  }

  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;
  const updated = stringField(fm.data.last_seen) || stringField(fm.data.updated) || stringField(fm.data.ingested) || dateFromPath(page.relPath);
  const title = stringField(fm.data.title) || page.relPath.split("/").pop()?.replace(/\.md$/, "") || page.relPath;

  return {
    source: {
      path: page.relPath,
      title,
      summary: summarize(body),
      updated,
      hash: createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
      topics,
      project,
      ...(stringField(fm.data.memory_kind) ? { memory_kind: stringField(fm.data.memory_kind) } : {}),
      ...(scope ? { memory_scope: scope } : {}),
      ...(stringField(fm.data.memory_policy) ? { memory_policy: stringField(fm.data.memory_policy) } : {}),
      memory_privacy: privacy,
      memory_status: status,
    },
    ...(metadataGaps.length > 0
      ? {
          reviewPage: {
            path: page.relPath,
            metadataGaps,
          },
        }
      : {}),
  };
}

function buildMemoryReviewFindings(input: {
  project: string;
  status: MemoryIndexStatus;
  indexState: MemoryIndexState;
  reviewPages: MemoryReviewPage[];
}): MemoryReviewFinding[] {
  const findings: MemoryReviewFinding[] = [];

  if (!input.status.cache_present) {
    findings.push({
      id: `cache_missing:${input.project}`,
      severity: "warn",
      kind: "cache_missing",
      message: `memory cache for ${input.project} is missing`,
      suggested_action: `Run skillwiki memory index --project ${input.project} to build the local cache.`,
    });
  } else if (input.status.stale) {
    findings.push({
      id: `cache_stale:${input.project}`,
      severity: "warn",
      kind: "cache_stale",
      message: `memory cache for ${input.project} is stale: ${input.status.drift.missing_sources.length} missing, ${input.status.drift.removed_sources.length} removed, ${input.status.drift.changed_sources.length} changed source(s)`,
      suggested_action: `Run skillwiki memory index --project ${input.project} or --if-stale to refresh the local cache.`,
    });
  }

  for (const path of input.status.drift.changed_sources) {
    findings.push({
      id: `source_hash_drift:${path}`,
      severity: "warn",
      kind: "source_hash_drift",
      path,
      message: `${path} changed since the last cache build`,
      suggested_action: `Refresh the cache for ${input.project} and review whether the source summary still matches.`,
    });
  }

  for (const warning of input.indexState.warnings) {
    const parsed = parseInvalidTopicWarning(warning);
    if (!parsed) continue;
    findings.push({
      id: `invalid_topic_slug:${parsed.path}:${parsed.topic}`,
      severity: "warn",
      kind: "invalid_topic_slug",
      path: parsed.path,
      topic: parsed.topic,
      message: `${parsed.path} declares invalid memory topic slug ${parsed.topic}`,
      suggested_action: "Normalize the topic slug to lowercase kebab-case so memory index and review can include it.",
    });
  }

  for (const page of input.reviewPages) {
    if (page.metadataGaps.length === 0) continue;
    findings.push({
      id: `metadata_gap:${page.path}`,
      severity: "warn",
      kind: "metadata_gap",
      path: page.path,
      message: `${page.path} is missing explicit memory metadata: ${page.metadataGaps.join(", ")}`,
      suggested_action: "Add the missing frontmatter fields before relying on this source for cross-device memory review.",
    });
  }

  const byTopic = groupSourcesByTopic(input.indexState.sources);
  for (const [topic, sources] of byTopic.entries()) {
    if (sources.length === 1) {
      findings.push({
        id: `sparse_topic:${topic}`,
        severity: "info",
        kind: "sparse_topic",
        topic,
        ...(sources[0]?.path ? { path: sources[0].path } : {}),
        message: `topic ${topic} has only one active memory source`,
        suggested_action: "Decide whether the topic needs more coverage or should stay intentionally narrow.",
      });
    }

    const hasProjectSource = sources.some((source) => isProjectMemorySource(source, input.project));
    const hasNonProjectScope = sources.some((source) => source.memory_scope === "global" || source.memory_scope === "cross-agent");
    if (hasProjectSource && hasNonProjectScope) {
      findings.push({
        id: `scope_gap:${topic}`,
        severity: "info",
        kind: "scope_gap",
        topic,
        message: `topic ${topic} mixes project and non-project memory scopes`,
        suggested_action: `Use skillwiki memory recall --project ${input.project} --topic ${topic} --scope <project|global|cross-agent|all> when reviewing this topic.`,
      });
    }

    if (sources.length >= 3) {
      findings.push({
        id: `consolidation_candidate:${topic}`,
        severity: "info",
        kind: "consolidation_candidate",
        topic,
        message: `topic ${topic} has ${sources.length} active memory sources and may be ready for consolidation`,
        suggested_action: "Review this topic in office-hours or proj-distill before promoting or merging related memory pages.",
      });
    }
  }

  return findings.sort(compareMemoryReviewFindings);
}

const COMMON_FAILURE_MATCH_TOKENS = new Set([
  "memory",
  "review",
  "test",
  "tests",
  "plugin",
  "cache",
  "command",
  "feature",
  "project",
  "status",
  "error",
  "warning",
  "warn",
  "info",
  "skillwiki",
  "dev",
  "loop",
]);

const FAILURE_MARKER_RE = /\b(?:miss|root cause|symptom|problem|friction|regression|bug)\b/i;

async function buildPastFailureFindings(
  pages: VaultPage[],
  project: string,
  target: string
): Promise<MemoryReviewFinding[]> {
  const targetProfile = buildPastFailureTargetProfile(target);
  if (!targetProfile) return [];

  const findings: MemoryReviewFinding[] = [];
  for (const page of dedupePages(pages)) {
    const body = await readPastFailureCandidateBody(page, project);
    if (!body) continue;

    const match = matchPastFailureTarget(targetProfile, body);
    if (!match) continue;

    findings.push({
      id: `past_failure_match:${page.relPath}`,
      severity: "warn",
      kind: "past_failure_match",
      path: page.relPath,
      message: `${page.relPath} matches pre-action target ${targetProfile.summary}: ${match.reason}`,
      suggested_action: `Read ${page.relPath} before executing; reuse the prior miss/root-cause notes if relevant.`,
    });
  }

  return findings.sort(compareMemoryReviewFindings);
}

interface PastFailureTargetProfile {
  summary: string;
  exactNeedles: string[];
  distinctiveTokens: string[];
}

function buildPastFailureTargetProfile(target: string): PastFailureTargetProfile | null {
  const normalizedTarget = normalizeMatchText(target);
  if (!normalizedTarget) return null;

  const distinctiveTokens = extractDistinctiveTargetTokens(target);
  const includeFullPhrase = normalizedTarget.length >= 12 && distinctiveTokens.length >= 2;
  const exactNeedles = uniqueStrings([
    includeFullPhrase ? normalizedTarget : "",
    ...extractPathLikeNeedles(target),
    ...extractFlagNeedles(target),
    ...extractCodeLikeNeedles(target),
  ]
    .map(normalizeMatchText)
    .filter((needle) => needle.length >= 4)
    .filter(hasDistinctiveNeedle));

  if (exactNeedles.length === 0 && distinctiveTokens.length < 2) return null;

  return {
    summary: summarizeTarget(target),
    exactNeedles,
    distinctiveTokens,
  };
}

async function readPastFailureCandidateBody(page: VaultPage, project: string): Promise<string | null> {
  if (isProjectRetroPath(page.relPath, project)) {
    return bodyWithoutFrontmatter(await readPage(page));
  }

  if (!isRawBugCapturePath(page.relPath)) return null;

  const text = await readPage(page);
  const fm = extractFrontmatter(text);
  if (!fm.ok || !frontmatterProjectMatches(fm.data.project, project)) return null;
  return bodyWithoutFrontmatter(text);
}

function isProjectRetroPath(path: string, project: string): boolean {
  return (path.startsWith(`projects/${project}/work/`) && path.endsWith("/retro.md"))
    || (path.startsWith(`projects/${project}/history/`) && path.endsWith("/retro.md"));
}

function isRawBugCapturePath(path: string): boolean {
  return /^raw\/transcripts\/.*-bug-.*\.md$/.test(path);
}

function frontmatterProjectMatches(value: unknown, project: string): boolean {
  if (typeof value === "string") return wikilinkSlug(value) === project;
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && wikilinkSlug(item) === project);
  }
  return false;
}

function bodyWithoutFrontmatter(text: string): string {
  const split = splitFrontmatter(text);
  return split.ok ? split.data.body : text;
}

function matchPastFailureTarget(
  target: PastFailureTargetProfile,
  candidateBody: string
): { reason: string } | null {
  const candidate = normalizeMatchText(candidateBody);
  if (!candidate) return null;

  const exactMatch = target.exactNeedles.find((needle) => candidate.includes(needle));
  if (exactMatch) {
    return { reason: `exact signal "${exactMatch}" appeared in prior failure memory` };
  }

  if (!FAILURE_MARKER_RE.test(candidateBody)) return null;

  const candidateTokens = new Set(tokenizeForMatch(candidate));
  const overlappingTokens = target.distinctiveTokens.filter((token) => candidateTokens.has(token));
  if (overlappingTokens.length >= 2) {
    return { reason: `distinctive target terms overlapped prior failure memory (${overlappingTokens.slice(0, 4).join(", ")})` };
  }

  return null;
}

function extractPathLikeNeedles(value: string): string[] {
  return value.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [];
}

function extractFlagNeedles(value: string): string[] {
  return value.match(/--[a-z][a-z0-9-]*/gi) ?? [];
}

function extractCodeLikeNeedles(value: string): string[] {
  return (value.match(/[A-Za-z0-9_.:-]*[_.:-][A-Za-z0-9_.:-]+/g) ?? [])
    .filter((needle) => /[A-Za-z]/.test(needle));
}

function extractDistinctiveTargetTokens(value: string): string[] {
  return uniqueStrings(tokenizeForMatch(value)
    .filter((token) => token.length >= 4)
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !COMMON_FAILURE_MATCH_TOKENS.has(token)));
}

function hasDistinctiveNeedle(value: string): boolean {
  return extractDistinctiveTargetTokens(value).length > 0;
}

function tokenizeForMatch(value: string): string[] {
  return normalizeMatchText(value).match(/[a-z0-9]+/g) ?? [];
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeTarget(target: string): string {
  const summary = target.replace(/\s+/g, " ").trim();
  if (summary.length <= 96) return JSON.stringify(summary);
  return JSON.stringify(`${summary.slice(0, 93).trimEnd()}...`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function parseInvalidTopicWarning(warning: string): { path: string; topic: string } | null {
  const match = warning.match(/^(.*): invalid memory topic slug (.+)$/);
  if (!match) return null;
  return {
    path: match[1] ?? "",
    topic: match[2] ?? "",
  };
}

function groupSourcesByTopic(sources: MemorySource[]): Map<string, MemorySource[]> {
  const byTopic = new Map<string, MemorySource[]>();
  for (const source of sources) {
    for (const topic of source.topics) {
      const list = byTopic.get(topic) ?? [];
      list.push(source);
      byTopic.set(topic, list);
    }
  }
  return byTopic;
}

function compareMemoryReviewFindings(a: MemoryReviewFinding, b: MemoryReviewFinding): number {
  return severityRank(b.severity) - severityRank(a.severity)
    || a.kind.localeCompare(b.kind)
    || (a.topic ?? "").localeCompare(b.topic ?? "")
    || (a.path ?? "").localeCompare(b.path ?? "")
    || a.id.localeCompare(b.id);
}

function severityRank(severity: MemoryReviewSeverity): number {
  return severity === "warn" ? 2 : 1;
}

function renderMemoryIndexStatusHint(status: MemoryIndexStatus): string {
  if (!status.cache_present) {
    return `memory index cache missing for ${status.project}; rebuild with memory index --project ${status.project}`;
  }
  if (!status.stale) {
    return `memory index cache current for ${status.project}: ${status.source_count} sources, ${status.topic_count} topics`;
  }
  const changed = status.drift.changed_sources.length;
  const missing = status.drift.missing_sources.length;
  const removed = status.drift.removed_sources.length;
  return `memory index cache stale for ${status.project}: ${missing} missing, ${removed} removed, ${changed} changed sources`;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function collectImportFiles(source: string): Promise<string[]> {
  const st = await stat(source);
  if (st.isFile()) return isImportCandidate(source) ? [source] : [];
  const files: string[] = [];
  await walkImportFiles(source, files);
  return files.sort((a, b) => a.localeCompare(b));
}

async function walkImportFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkImportFiles(path, out);
    } else if (entry.isFile() && isImportCandidate(path)) {
      out.push(path);
    }
  }
}

function isImportCandidate(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".md" || ext === ".txt";
}

async function buildImportEntry(
  file: string,
  sourceRoot: string,
  project: string,
  today: string,
  maxBytes: number
): Promise<MemoryImportEntry> {
  const st = await stat(file);
  const sourceKind = classifyImportSource(file);
  const hash = createHash("sha256").update(await readFile(file)).digest("hex");
  const baseEntry = {
    source_path: file,
    source_kind: sourceKind,
    sha256: hash,
    memory_kind: defaultImportKind(sourceKind),
    memory_privacy: "local",
    redaction_count: 0,
  };

  if (st.size > maxBytes) {
    return {
      ...baseEntry,
      status: "rejected",
      reason: "oversized_source",
    };
  }

  if (sourceKind === "codex-rule" || sourceKind === "agents-policy") {
    return {
      ...baseEntry,
      status: "rejected",
      reason: "policy_source_not_imported",
    };
  }

  const text = await readFile(file, "utf8");
  const extracted = extractImportText(text, sourceKind);
  if (!extracted) {
    return {
      ...baseEntry,
      status: "rejected",
      reason: "policy_source_not_imported",
    };
  }

  const redacted = redactSensitiveContent(extracted, { file });
  const privacy = redacted.findings.length > 0 ? "sensitive" : "local";
  const sourceSlug = slugify(basename(file, extname(file)));
  const relSource = relative(sourceRoot, file).split(sep).join("/");

  const entry: MemoryImportEntry = {
    ...baseEntry,
    status: "ready",
    memory_privacy: privacy,
    redaction_count: redacted.findings.length,
    proposed_path: `raw/transcripts/${today}-memory-import-${sourceSlug}.md`,
    source_path: relSource || file,
  };
  Object.defineProperty(entry, "__content", { value: redacted.text, enumerable: false });
  Object.defineProperty(entry, "__project", { value: project, enumerable: false });
  return entry;
}

async function writeImportCapture(
  vault: string,
  entry: MemoryImportEntry,
  today: string
): Promise<{ relPath: string; validation: { valid: boolean; exit_code: number } }> {
  const content = hiddenString(entry, "__content");
  const project = hiddenString(entry, "__project");
  const relPath = await availableImportPath(vault, entry.proposed_path!);
  const absPath = join(vault, relPath);
  await mkdir(join(vault, "raw", "transcripts"), { recursive: true });
  await writeFile(absPath, renderImportCapture(entry, content, project, today), "utf8");
  const validation = await runValidate({ file: absPath });
  return {
    relPath,
    validation: {
      valid: validation.exitCode === ExitCode.OK,
      exit_code: validation.exitCode,
    },
  };
}

async function availableImportPath(vault: string, proposed: string): Promise<string> {
  const ext = extname(proposed);
  const stem = proposed.slice(0, -ext.length);
  let candidate = proposed;
  let i = 2;
  while (await readIfExists(join(vault, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i++;
  }
  return candidate;
}

function renderImportCapture(entry: MemoryImportEntry, content: string, project: string, today: string): string {
  return [
    "---",
    "source_url:",
    `ingested: ${today}`,
    "kind: note",
    `project: "[[${project}]]"`,
    `memory_kind: ${entry.memory_kind}`,
    "memory_topics: [imported-memory]",
    "memory_scope: project",
    "memory_policy: historical",
    `memory_privacy: ${entry.memory_privacy}`,
    "memory_status: active",
    `source_agent: skillwiki memory import`,
    `source_hash: ${entry.sha256}`,
    `source_paths: ["${entry.source_path.replaceAll("\"", "\\\"")}"]`,
    "---",
    "",
    `# Imported Memory: ${basename(entry.source_path, extname(entry.source_path))}`,
    "",
    `Source kind: ${entry.source_kind}`,
    "",
    "Promotion guidance: review this raw capture before promoting it to compound or typed knowledge.",
    "",
    content.trimEnd(),
    "",
  ].join("\n");
}

function hiddenString(entry: MemoryImportEntry, key: "__content" | "__project"): string {
  return (entry as unknown as Record<string, string>)[key] ?? "";
}

function classifyImportSource(file: string): string {
  const rel = file.split(sep).join("/");
  const name = basename(file);
  if (rel.includes("/.codex/memories/")) return "codex-memory";
  if (rel.includes("/.codex/rules/")) return "codex-rule";
  if (rel.includes("/.claude/") && name === "napkin.md") return "napkin";
  if (rel.includes("/.memsearch/memory/")) return "memsearch";
  if (name === "AGENTS.md") return "agents-policy";
  if (name === "CLAUDE.md") return "claude-auto-memory";
  return "generic";
}

function defaultImportKind(sourceKind: string): string {
  switch (sourceKind) {
    case "codex-memory":
    case "claude-auto-memory":
      return "preference";
    case "napkin":
      return "correction";
    case "memsearch":
      return "handoff";
    default:
      return "handoff";
  }
}

function extractImportText(text: string, sourceKind: string): string {
  if (sourceKind !== "claude-auto-memory") return text;
  const match = text.match(/<!--\s*AUTO-MEMORY:START\s*-->([\s\S]*?)<!--\s*AUTO-MEMORY:END\s*-->/i);
  return match?.[1]?.trim() ?? "";
}

function normalizeTopics(value: unknown): MemoryTopic[] {
  if (!Array.isArray(value)) return [];

  const topics: MemoryTopic[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = stringField(item.name);
    const summary = stringField(item.summary);
    const updated = stringField(item.updated);
    const paths = stringArray(item.paths);
    if (!name || !summary || !updated || paths.length === 0) continue;
    const project = stringField(item.project);
    topics.push({
      name,
      summary,
      ...(project ? { project } : {}),
      updated,
      paths,
    });
  }
  return topics;
}

function normalizeSources(value: unknown): MemorySource[] {
  if (!Array.isArray(value)) return [];

  const sources: MemorySource[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = stringField(item.path);
    const title = stringField(item.title);
    const summary = stringField(item.summary);
    const updated = stringField(item.updated);
    const hash = stringField(item.hash);
    const topics = stringArray(item.topics);
    if (!path || !title || !summary || !updated || !hash || topics.length === 0) continue;
    const project = stringField(item.project);
    sources.push({
      path,
      title,
      summary,
      updated,
      hash,
      topics,
      ...(project ? { project } : {}),
      ...(stringField(item.memory_kind) ? { memory_kind: stringField(item.memory_kind) } : {}),
      ...(stringField(item.memory_scope) ? { memory_scope: stringField(item.memory_scope) } : {}),
      ...(stringField(item.memory_policy) ? { memory_policy: stringField(item.memory_policy) } : {}),
      memory_privacy: stringField(item.memory_privacy) || "local",
      memory_status: stringField(item.memory_status) || "active",
    });
  }
  return sources;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 10;
  return Math.floor(value);
}

function compareTopics(a: MemoryTopic, b: MemoryTopic): number {
  return b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name);
}

function compareSources(a: MemorySource, b: MemorySource): number {
  return b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path);
}

function normalizeRecallScope(value: string | undefined): MemoryRecallScope | undefined {
  if (!value) return undefined;
  return isRecallScope(value) ? value : undefined;
}

function isValidMemoryTopicSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function isRecallScope(value: string): value is MemoryRecallScope {
  return value === "project" || value === "global" || value === "cross-agent" || value === "all";
}

function recallScopeMatches(source: MemorySource, project: string, scope: MemoryRecallScope | undefined): boolean {
  if (!scope || scope === "all") return true;
  if (scope === "project") return isProjectMemorySource(source, project);
  return source.memory_scope === scope;
}

function compareRecallSources(
  a: MemorySource,
  b: MemorySource,
  project: string,
  scope: MemoryRecallScope | undefined
): number {
  if (scope !== "all") return compareSources(a, b);
  return b.updated.localeCompare(a.updated)
    || Number(isProjectMemorySource(b, project)) - Number(isProjectMemorySource(a, project))
    || a.path.localeCompare(b.path);
}

function isProjectMemorySource(source: MemorySource, project: string): boolean {
  const scope = source.memory_scope || "project";
  return scope === "project" && (!source.project || source.project === project);
}

function renderHumanHint(topics: MemoryTopic[]): string {
  if (topics.length === 0) return "no memory topics found";
  return topics
    .map((topic) => {
      const project = topic.project ? ` [${topic.project}]` : "";
      return `${topic.updated} ${topic.name}${project} — ${topic.summary} (${topic.paths.join(", ")})`;
    })
    .join("\n");
}

function renderRecallHint(topic: string, sources: MemorySource[]): string {
  if (sources.length === 0) return `no memory sources found for topic ${topic}`;
  return sources
    .map((source) => `${source.updated} ${source.title} (${source.path}) — ${source.summary}`)
    .join("\n");
}

function renderMemoryReviewHint(
  project: string,
  status: MemoryIndexStatus,
  findings: MemoryReviewFinding[]
): string {
  const warns = findings.filter((finding) => finding.severity === "warn").length;
  const infos = findings.length - warns;
  const cacheStatus = !status.cache_present
    ? "cache missing"
    : status.stale
      ? "cache stale"
      : "cache current";
  return `memory review for ${project}: ${findings.length} finding(s) (${warns} warn, ${infos} info); ${cacheStatus}`;
}

function memoryCacheRelPath(project: string): string {
  return `.skillwiki/memory/${project}/topics.json`;
}

async function readMemoryCache(vault: string, project?: string): Promise<string> {
  if (project) {
    const projectCache = await readIfExists(join(vault, memoryCacheRelPath(project)));
    if (projectCache) return projectCache;
  }
  return readIfExists(join(vault, ".skillwiki", "memory-topics.json"));
}

function dedupePages(pages: VaultPage[]): VaultPage[] {
  const seen = new Set<string>();
  const out: VaultPage[] = [];
  for (const page of pages) {
    if (seen.has(page.relPath)) continue;
    seen.add(page.relPath);
    out.push(page);
  }
  return out;
}

function normalizeMemoryTopics(value: unknown, path: string, warnings: string[]): string[] {
  const rawTopics = typeof value === "string" ? [value] : stringArray(value);
  const topics: string[] = [];
  for (const topic of rawTopics) {
    if (!isValidMemoryTopicSlug(topic)) {
      warnings.push(`${path}: invalid memory topic slug ${topic}`);
      continue;
    }
    if (!topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

function memoryProjects(path: string, fm: Record<string, unknown>): string[] {
  const projects = new Set<string>();
  const project = wikilinkSlug(fm.project);
  if (project) projects.add(project);
  if (Array.isArray(fm.provenance_projects)) {
    for (const value of fm.provenance_projects) {
      const slug = wikilinkSlug(value);
      if (slug) projects.add(slug);
    }
  }
  const pathProject = path.match(/^projects\/([^/]+)\//)?.[1];
  if (pathProject) projects.add(pathProject);
  return [...projects];
}

function buildTopics(project: string, sources: MemorySource[]): MemoryTopic[] {
  const byTopic = new Map<string, MemorySource[]>();
  for (const source of sources) {
    for (const topic of source.topics) {
      const list = byTopic.get(topic) ?? [];
      list.push(source);
      byTopic.set(topic, list);
    }
  }

  return [...byTopic.entries()]
    .map(([name, topicSources]) => {
      const sorted = [...topicSources].sort(compareSources);
      return {
        name,
        project,
        summary: sorted[0]?.summary ?? "",
        updated: sorted[0]?.updated ?? "",
        paths: sorted.map((source) => source.path),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function wikilinkSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^\[\[([^\]]+)\]\]$/);
  return match?.[1] ?? value;
}

function summarize(body: string): string {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  const summary = lines.join(" ").replace(/\s+/g, " ").trim();
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;
}

function dateFromPath(path: string): string {
  return path.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}
