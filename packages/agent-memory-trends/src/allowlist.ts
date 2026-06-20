import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "./types.js";

export interface RunManifestOutputs {
  evidencePath?: string;
  digestPath?: string;
  taskCapturePaths?: string[];
  taskCaptureRenderer?: string;
  sessionBriefPath?: string;
  sessionBriefCachePaths?: string[];
  sessionBriefSupportPaths?: string[];
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

const SESSION_BRIEF_PATH = "meta/latest-session-brief.md";
const SESSION_BRIEF_CACHE_PATHS = [".skillwiki/session-brief.md", ".skillwiki/session-brief.json"];
const SESSION_BRIEF_SUPPORT_PATHS = ["index.md", "log.md"];
const WATCHLIST_PATH = "projects/llm-wiki/architecture/agent-memory-research-sources.yaml";
const TYPED_KNOWLEDGE_PREFIXES = ["concepts/", "entities/", "comparisons/", "queries/", "meta/"];

export function isAllowedGeneratedPath(path: string, runDate: string): boolean {
  return (
    isRunEvidencePath(path, runDate) ||
    path === `queries/${runDate}-agent-memory-trends-digest.md` ||
    (/^raw\/transcripts\/\d{4}-\d{2}-\d{2}-(task|bug|idea)-[^/]+\.md$/.test(path) &&
      (path.startsWith(`raw/transcripts/${runDate}-task-`) ||
        path.startsWith(`raw/transcripts/${runDate}-bug-`) ||
        path.startsWith(`raw/transcripts/${runDate}-idea-`))) ||
    path === SESSION_BRIEF_PATH ||
    SESSION_BRIEF_CACHE_PATHS.includes(path) ||
    SESSION_BRIEF_SUPPORT_PATHS.includes(path) ||
    isAgentMemoryRunStatePath(path, runDate) ||
    path === WATCHLIST_PATH
  );
}

export function generatedPathCategory(path: string, runDate: string): string {
  if (isRunEvidencePath(path, runDate)) return "evidence";
  if (path === `queries/${runDate}-agent-memory-trends-digest.md`) return "digest";
  const captureMatch = path.match(/^raw\/transcripts\/\d{4}-\d{2}-\d{2}-(task|bug|idea)-[^/]+\.md$/);
  if (captureMatch) return `${captureMatch[1]}-capture`;
  if (path === SESSION_BRIEF_PATH) return "session-brief";
  if (SESSION_BRIEF_CACHE_PATHS.includes(path)) return "session-brief-cache";
  if (SESSION_BRIEF_SUPPORT_PATHS.includes(path)) return "session-brief-support";
  if (isAgentMemoryRunStatePath(path, runDate)) return "run-state";
  if (path === WATCHLIST_PATH) return "watchlist";
  if (TYPED_KNOWLEDGE_PREFIXES.some((prefix) => path.startsWith(prefix))) return "typed-knowledge";
  if (path.startsWith("raw/articles/")) return "raw-article";
  if (path.startsWith("raw/transcripts/")) return "raw-transcript";
  if (path.startsWith(".skillwiki/")) return "skillwiki-state";
  if (path.startsWith("projects/")) return "project-work";
  return "unclassified";
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
    if (!isAllowedGeneratedPath(path, input.runDate)) {
      issues.push(`${pathDiagnostic(path, input.runDate)} is not in generated-output allowlist`);
    }
  }

  const taskCaptures = input.manifest.outputs.taskCapturePaths ?? [];
  if (taskCaptures.length > 3) issues.push("expected 0-3 task captures");
  if (taskCaptures.length > 0 && input.manifest.outputs.taskCaptureRenderer !== "typescript") {
    issues.push("task captures must be rendered by TypeScript");
  }
  if ((input.manifest.webSources ?? []).length > 15) issues.push("expected max 15 web sources");

  const digestPaths = changedFiles.filter((path) => path === `queries/${input.runDate}-agent-memory-trends-digest.md`);
  if (digestPaths.length !== 1 && !isQuietRunStateOnlyChangeSet(changedFiles, input.runDate)) {
    issues.push("expected exactly one digest on successful runs");
  }

  const outputPaths = new Set([
    input.manifest.outputs.evidencePath,
    input.manifest.outputs.digestPath,
    ...(input.manifest.outputs.taskCapturePaths ?? []),
    input.manifest.outputs.sessionBriefPath,
    ...(input.manifest.outputs.sessionBriefCachePaths ?? []),
    ...(input.manifest.outputs.sessionBriefSupportPaths ?? []),
    input.manifest.outputs.runStatePath,
    input.manifest.outputs.latestRunPath,
    input.manifest.outputs.watchlistPath,
  ].filter((path): path is string => typeof path === "string" && path.length > 0));

  for (const path of changedFiles) {
    if (!outputPaths.has(path) && !path.startsWith(".skillwiki/agent-memory-trends/")) {
      issues.push(`${pathDiagnostic(path, input.runDate)} is changed but not declared in manifest outputs`);
    }
  }

  for (const path of changedFiles) {
    inspectChangedFile(input.vault, path, input.runDate, input.maxFileBytes, issues);
    if (isRawPath(path) && input.existingRawPaths.includes(path)) {
      issues.push(`${pathDiagnostic(path, input.runDate)} rewrites an existing raw file`);
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
        taskCaptureRenderer: stringField(outputs.task_capture_renderer ?? outputs.taskCaptureRenderer),
        sessionBriefPath: stringField(outputs.session_brief_path ?? outputs.sessionBriefPath),
        sessionBriefCachePaths: stringArray(outputs.session_brief_cache_paths ?? outputs.sessionBriefCachePaths),
        sessionBriefSupportPaths: stringArray(outputs.session_brief_support_paths ?? outputs.sessionBriefSupportPaths),
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

function isRunEvidencePath(path: string, runDate: string): boolean {
  return (
    path === `raw/articles/${runDate}-agent-memory-trends-evidence.md` ||
    new RegExp(`^raw/articles/${escapeRegExp(runDate)}-agent-memory-trends-evidence-[A-Za-z0-9.+-]+\\.md$`).test(path)
  );
}

function isAgentMemoryRunStatePath(path: string, runDate: string): boolean {
  return (
    path === `.skillwiki/agent-memory-trends/${runDate}-input.json` ||
    path === `.skillwiki/agent-memory-trends/${runDate}-run.json` ||
    path === ".skillwiki/agent-memory-trends/latest-run.json"
  );
}

function isQuietRunStateOnlyChangeSet(paths: string[], runDate: string): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => isAgentMemoryRunStatePath(path, runDate)) &&
    paths.includes(`.skillwiki/agent-memory-trends/${runDate}-run.json`) &&
    paths.includes(".skillwiki/agent-memory-trends/latest-run.json")
  );
}

function inspectChangedFile(vault: string, path: string, runDate: string, maxFileBytes: number, issues: string[]): void {
  const fullPath = join(vault, path);
  const diagnosticPath = pathDiagnostic(path, runDate);
  if (!existsSync(fullPath)) {
    issues.push(`${diagnosticPath} does not exist`);
    return;
  }

  const lstat = lstatSync(fullPath);
  if (lstat.isSymbolicLink()) {
    issues.push(`${diagnosticPath} is a symlink`);
    return;
  }
  if (!lstat.isFile()) {
    issues.push(`${diagnosticPath} is not a regular file`);
    return;
  }
  if ((lstat.mode & 0o111) !== 0) issues.push(`${diagnosticPath} is executable`);

  const stat = statSync(fullPath);
  if (!isSessionBriefSupportPath(path) && stat.size > maxFileBytes) {
    issues.push(`${diagnosticPath} is oversized (${stat.size} bytes > ${maxFileBytes})`);
  }

  const body = readFileSync(fullPath, "utf8");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(body))) issues.push(`${diagnosticPath} contains secret-like content`);
}

function pathDiagnostic(path: string, runDate: string): string {
  return `${path} [${generatedPathCategory(path, runDate)}]`;
}

function isRawPath(path: string): boolean {
  return path.startsWith("raw/articles/") || path.startsWith("raw/transcripts/");
}

function isTypedPagePath(path: string): boolean {
  return path.startsWith("queries/") || path === SESSION_BRIEF_PATH;
}

function isSessionBriefSupportPath(path: string): boolean {
  return SESSION_BRIEF_SUPPORT_PATHS.includes(path);
}

function compareTypedPageValidationOrder(left: string, right: string): number {
  return typedPagePriority(left) - typedPagePriority(right) || left.localeCompare(right);
}

function typedPagePriority(path: string): number {
  if (path.startsWith("queries/")) return 0;
  if (path === SESSION_BRIEF_PATH) return 1;
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
