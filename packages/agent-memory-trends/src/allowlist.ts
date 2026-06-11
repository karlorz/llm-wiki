import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "./types.js";

export interface RunManifestOutputs {
  evidencePath?: string;
  digestPath?: string;
  taskCapturePaths?: string[];
  sessionBriefPath?: string;
  runStatePath?: string;
  latestRunPath?: string;
  watchlistPath?: string;
}

export interface RunManifest {
  runDate: string;
  status?: string;
  changedFiles: string[];
  outputs: RunManifestOutputs;
  webSources: string[];
}

export interface ValidateGeneratedChangesInput {
  vault: string;
  runDate: string;
  changedFiles: string[];
  manifest: RunManifest;
  existingRawPaths: string[];
  maxFileBytes: number;
}

export interface ValidateGeneratedChangesOutput {
  rawPagesToValidate: string[];
  typedPagesToValidate: string[];
  digestPathForAudit?: string;
}

const SECRET_PATTERNS = [
  /OPENAI_API_KEY\s*=\s*sk-[A-Za-z0-9_-]+/i,
  /CODEX_API_KEY\s*=\s*[A-Za-z0-9_-]{12,}/i,
  /GITHUB_TOKEN\s*=\s*(ghp|github_pat)_[A-Za-z0-9_]+/i,
  /AGENT_MEMORY_TRENDS_HEARTBEAT_URL\s*=\s*https?:\/\/\S+/i,
];

export function isAllowedGeneratedPath(path: string, runDate: string): boolean {
  return (
    path === `raw/articles/${runDate}-agent-memory-trends-evidence.md` ||
    new RegExp(`^raw/articles/${escapeRegExp(runDate)}-agent-memory-trends-evidence-[A-Za-z0-9.+-]+\\.md$`).test(path) ||
    path === `queries/${runDate}-agent-memory-trends-digest.md` ||
    (/^raw\/transcripts\/\d{4}-\d{2}-\d{2}-task-[^/]+\.md$/.test(path) && path.startsWith(`raw/transcripts/${runDate}-task-`)) ||
    path === "meta/latest-session-brief.md" ||
    path === `.skillwiki/agent-memory-trends/${runDate}-input.json` ||
    path === `.skillwiki/agent-memory-trends/${runDate}-run.json` ||
    path === ".skillwiki/agent-memory-trends/latest-run.json" ||
    path === "projects/llm-wiki/architecture/agent-memory-research-sources.yaml"
  );
}

export function validateGeneratedChanges(input: ValidateGeneratedChangesInput): Result<ValidateGeneratedChangesOutput> {
  const issues: string[] = [];
  const changedFiles = normalizePathList(input.changedFiles);
  const manifestChangedFiles = normalizePathList(input.manifest.changedFiles);

  if (input.manifest.runDate !== input.runDate) {
    issues.push(`run manifest date ${input.manifest.runDate} does not match run date ${input.runDate}`);
  }
  if (input.manifest.status && input.manifest.status !== "success") {
    issues.push(`run manifest status ${input.manifest.status} is not publishable`);
  }

  if (changedFiles.join("\n") !== manifestChangedFiles.join("\n")) {
    issues.push("run manifest changed_files does not match actual git diff");
  }

  for (const path of changedFiles) {
    if (!isAllowedGeneratedPath(path, input.runDate)) issues.push(`${path} is not in generated-output allowlist`);
  }

  const taskCaptures = input.manifest.outputs.taskCapturePaths ?? [];
  if (taskCaptures.length > 3) issues.push("expected 0-3 task captures");
  if ((input.manifest.webSources ?? []).length > 15) issues.push("expected max 15 web sources");

  const digestPaths = changedFiles.filter((path) => path === `queries/${input.runDate}-agent-memory-trends-digest.md`);
  if (digestPaths.length !== 1) issues.push("expected exactly one digest on successful runs");

  const outputPaths = new Set([
    input.manifest.outputs.evidencePath,
    input.manifest.outputs.digestPath,
    ...(input.manifest.outputs.taskCapturePaths ?? []),
    input.manifest.outputs.sessionBriefPath,
    input.manifest.outputs.runStatePath,
    input.manifest.outputs.latestRunPath,
    input.manifest.outputs.watchlistPath,
  ].filter((path): path is string => typeof path === "string" && path.length > 0));

  for (const path of changedFiles) {
    if (!outputPaths.has(path) && !path.startsWith(".skillwiki/agent-memory-trends/")) {
      issues.push(`${path} is changed but not declared in manifest outputs`);
    }
  }

  for (const path of changedFiles) {
    inspectChangedFile(input.vault, path, input.maxFileBytes, issues);
    if (isRawPath(path) && input.existingRawPaths.includes(path)) {
      issues.push(`${path} rewrites an existing raw file`);
    }
  }

  issues.push(...caseCollisionIssues(changedFiles));

  if (issues.length > 0) return err("ALLOWLIST_REJECTED", issues.join("; "));

  return ok({
    rawPagesToValidate: changedFiles.filter(isRawPath),
    typedPagesToValidate: changedFiles.filter(isTypedPagePath).sort(compareTypedPageValidationOrder),
    digestPathForAudit: input.manifest.outputs.digestPath,
  });
}

export function parseRunManifest(text: string): Result<RunManifest> {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const outputs = asRecord(raw.outputs ?? {}, "outputs");
    return ok({
      runDate: stringField(raw.run_date ?? raw.runDate),
      status: stringField(raw.status),
      changedFiles: stringArray(raw.changed_files ?? raw.changedFiles),
      outputs: {
        evidencePath: stringField(outputs.evidence_path ?? outputs.evidencePath),
        digestPath: stringField(outputs.digest_path ?? outputs.digestPath),
        taskCapturePaths: stringArray(outputs.task_capture_paths ?? outputs.taskCapturePaths),
        sessionBriefPath: stringField(outputs.session_brief_path ?? outputs.sessionBriefPath),
        runStatePath: stringField(outputs.run_state_path ?? outputs.runStatePath),
        latestRunPath: stringField(outputs.latest_run_path ?? outputs.latestRunPath),
        watchlistPath: stringField(outputs.watchlist_path ?? outputs.watchlistPath),
      },
      webSources: stringArray(raw.web_sources ?? raw.webSources),
    });
  } catch (error) {
    return err("MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inspectChangedFile(vault: string, path: string, maxFileBytes: number, issues: string[]): void {
  const fullPath = join(vault, path);
  if (!existsSync(fullPath)) {
    issues.push(`${path} does not exist`);
    return;
  }

  const lstat = lstatSync(fullPath);
  if (lstat.isSymbolicLink()) {
    issues.push(`${path} is a symlink`);
    return;
  }
  if (!lstat.isFile()) {
    issues.push(`${path} is not a regular file`);
    return;
  }
  if ((lstat.mode & 0o111) !== 0) issues.push(`${path} is executable`);

  const stat = statSync(fullPath);
  if (stat.size > maxFileBytes) issues.push(`${path} is oversized (${stat.size} bytes > ${maxFileBytes})`);

  const body = readFileSync(fullPath, "utf8");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(body))) issues.push(`${path} contains secret-like content`);
}

function isRawPath(path: string): boolean {
  return path.startsWith("raw/articles/") || path.startsWith("raw/transcripts/");
}

function isTypedPagePath(path: string): boolean {
  return path.startsWith("queries/") || path === "meta/latest-session-brief.md";
}

function compareTypedPageValidationOrder(left: string, right: string): number {
  return typedPagePriority(left) - typedPagePriority(right) || left.localeCompare(right);
}

function typedPagePriority(path: string): number {
  if (path.startsWith("queries/")) return 0;
  if (path === "meta/latest-session-brief.md") return 1;
  return 2;
}

function normalizePathList(paths: string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function caseCollisionIssues(paths: string[]): string[] {
  const seen = new Map<string, string>();
  const issues: string[] = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const previous = seen.get(lower);
    if (previous && previous !== path) issues.push(`case collision: ${previous} and ${path}`);
    seen.set(lower, path);
  }
  return issues;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
