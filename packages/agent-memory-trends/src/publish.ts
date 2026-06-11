import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseRunManifest,
  validateGeneratedChanges,
  type RunManifest,
  type ValidateGeneratedChangesOutput,
} from "./allowlist.js";
import type { CommandRunner, CommandResult } from "./git.js";
import { err, ok, type Result } from "./types.js";

export interface PublisherCommand {
  tool: "git" | "skillwiki";
  args: string[];
}

export interface PublisherLock {
  release: () => Promise<void>;
}

export interface PublishGeneratedChangesInput {
  vault: string;
  runDate: string;
  manifestPath: string;
  acquireLock: () => Promise<Result<PublisherLock>>;
  git: CommandRunner;
  skillwiki: CommandRunner;
  existingRawPaths: string[];
}

export interface PublishGeneratedChangesOutput {
  baseCommit: string;
  changedFiles: string[];
  commitMessage: string;
}

interface ManifestFile {
  manifest: RunManifest;
  raw: Record<string, unknown>;
}

interface NormalizedOperationalFiles {
  manifest: RunManifest;
  changedFiles: string[];
}

const MAX_GENERATED_FILE_BYTES = 256 * 1024;
const SESSION_BRIEF_PATH = "meta/latest-session-brief.md";
const SESSION_BRIEF_CACHE_PATHS = [".skillwiki/session-brief.md", ".skillwiki/session-brief.json"];
const SESSION_BRIEF_SUPPORT_PATHS = ["index.md", "log.md"];

export async function publishGeneratedChanges(input: PublishGeneratedChangesInput): Promise<Result<PublishGeneratedChangesOutput>> {
  const lock = await input.acquireLock();
  if (!lock.ok) return lock;

  try {
    const fetch = await runGit(input.git, ["fetch", "origin", "main"]);
    if (!fetch.ok) return fetch;

    const baseCommit = await runGit(input.git, ["rev-parse", "HEAD"]);
    if (!baseCommit.ok) return baseCommit;

    const status = await runGit(input.git, ["status", "--porcelain", "--untracked-files=all"]);
    if (!status.ok) return status;
    const observedChangedFiles = filesFromPorcelainStatus(status.data.stdout);

    const manifest = readManifest(input.vault, input.manifestPath);
    if (!manifest.ok) return manifest;
    const normalized = normalizeManifestForOperationalFiles(input.vault, input.manifestPath, manifest.data, observedChangedFiles, input.runDate);
    if (!normalized.ok) return normalized;

    const validation = validateGeneratedChanges({
      vault: input.vault,
      runDate: input.runDate,
      changedFiles: normalized.data.changedFiles,
      manifest: normalized.data.manifest,
      existingRawPaths: input.existingRawPaths,
      maxFileBytes: MAX_GENERATED_FILE_BYTES,
    });
    if (!validation.ok) return err("VALIDATION_FAILED", validation.detail);

    const skillwikiValidation = await validateWithSkillwiki(input, validation.data);
    if (!skillwikiValidation.ok) return skillwikiValidation;

    const gitAdd = await runGit(input.git, ["add", "--", ...normalized.data.changedFiles]);
    if (!gitAdd.ok) return gitAdd;

    const commitMessage = `research(agent-memory): daily digest ${input.runDate}`;
    const commit = await runGit(input.git, ["commit", "-m", commitMessage]);
    if (!commit.ok) return commit;

    const pull = await runGit(input.git, ["pull", "--rebase", "origin", "main"]);
    if (!pull.ok) return pull;

    const push = await runGit(input.git, ["push", "origin", "HEAD:main"]);
    if (!push.ok) return push;

    return ok({
      baseCommit: baseCommit.data.stdout.trim(),
      changedFiles: normalized.data.changedFiles,
      commitMessage,
    });
  } finally {
    await lock.data.release();
  }
}

async function validateWithSkillwiki(
  input: PublishGeneratedChangesInput,
  validation: ValidateGeneratedChangesOutput
): Promise<Result<{ validated: true }>> {
  for (const path of [...validation.rawPagesToValidate, ...validation.typedPagesToValidate]) {
    const result = await runSkillwiki(input.skillwiki, ["validate", join(input.vault, path)]);
    if (!result.ok) return result;
  }

  const lint = await runAdvisoryLint(input);
  if (!lint.ok) return lint;

  if (validation.digestPathForAudit) {
    const audit = await runSkillwiki(input.skillwiki, ["audit", join(input.vault, validation.digestPathForAudit)]);
    if (!audit.ok) return audit;
  }

  return ok({ validated: true });
}

function readManifest(vault: string, manifestPath: string): Result<ManifestFile> {
  const text = readFileSync(join(vault, manifestPath), "utf8");
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw)) return err("MANIFEST_INVALID", "run manifest must be an object");
    const manifest = parseRunManifest(text);
    if (!manifest.ok) return manifest;
    return ok({ manifest: manifest.data, raw });
  } catch (error) {
    return err("MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }
}

function normalizeManifestForOperationalFiles(
  vault: string,
  manifestPath: string,
  manifestFile: ManifestFile,
  changedFiles: string[],
  runDate: string
): Result<NormalizedOperationalFiles> {
  const inputPath = `.skillwiki/agent-memory-trends/${runDate}-input.json`;
  const latestRunPath = ".skillwiki/agent-memory-trends/latest-run.json";
  const changedFileSet = new Set(changedFiles);
  changedFileSet.add(latestRunPath);

  const manifestChangedFileSet = new Set(manifestFile.manifest.changedFiles);
  if (changedFiles.includes(inputPath)) manifestChangedFileSet.add(inputPath);
  manifestChangedFileSet.add(latestRunPath);
  for (const path of [SESSION_BRIEF_PATH, ...SESSION_BRIEF_CACHE_PATHS, ...SESSION_BRIEF_SUPPORT_PATHS]) {
    if (changedFiles.includes(path)) manifestChangedFileSet.add(path);
  }

  const raw = cloneRecord(manifestFile.raw);
  raw.changed_files = [...manifestChangedFileSet].sort((left, right) => left.localeCompare(right));
  const outputs = isRecord(raw.outputs) ? cloneRecord(raw.outputs) : {};
  if (changedFiles.includes(SESSION_BRIEF_PATH)) {
    outputs.session_brief_path = SESSION_BRIEF_PATH;
  }
  const changedCachePaths = SESSION_BRIEF_CACHE_PATHS.filter((path) => changedFiles.includes(path));
  if (changedCachePaths.length > 0) {
    const existingCachePaths = stringArray(outputs.session_brief_cache_paths ?? outputs.sessionBriefCachePaths);
    outputs.session_brief_cache_paths = [...new Set([...existingCachePaths, ...changedCachePaths])]
      .sort((left, right) => left.localeCompare(right));
  }
  const changedSupportPaths = SESSION_BRIEF_SUPPORT_PATHS.filter((path) => changedFiles.includes(path));
  if (changedSupportPaths.length > 0) {
    const existingSupportPaths = stringArray(outputs.session_brief_support_paths ?? outputs.sessionBriefSupportPaths);
    outputs.session_brief_support_paths = [...new Set([...existingSupportPaths, ...changedSupportPaths])]
      .sort((left, right) => left.localeCompare(right));
  }
  if (typeof outputs.run_state_path !== "string" && typeof outputs.runStatePath !== "string") {
    outputs.run_state_path = manifestPath;
  }
  outputs.latest_run_path = latestRunPath;
  raw.outputs = outputs;

  const body = JSON.stringify(raw, null, 2) + "\n";
  try {
    writeFileSync(join(vault, manifestPath), body, "utf8");
    writeFileSync(join(vault, latestRunPath), body, "utf8");
  } catch (error) {
    return err("MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }

  const manifest = parseRunManifest(body);
  if (!manifest.ok) return manifest;
  return ok({
    manifest: manifest.data,
    changedFiles: [...changedFileSet].sort((left, right) => left.localeCompare(right)),
  });
}

async function runGit(runner: CommandRunner, args: string[]): Promise<Result<CommandResult>> {
  const result = await runner(args);
  if (result.exitCode !== 0) return err("GIT_FAILED", { args, stderr: result.stderr, stdout: result.stdout });
  return ok(result);
}

async function runSkillwiki(runner: CommandRunner, args: string[]): Promise<Result<CommandResult>> {
  const result = await runner(args);
  if (result.exitCode !== 0) return err("VALIDATION_FAILED", { args, stderr: result.stderr, stdout: result.stdout });
  return ok(result);
}

async function runAdvisoryLint(input: PublishGeneratedChangesInput): Promise<Result<{ linted: true }>> {
  const args = ["lint", input.vault, "--summary"];
  const result = await input.skillwiki(args);
  if (result.exitCode === 0 || hasStructuredLintSummary(result.stdout)) return ok({ linted: true });
  return err("VALIDATION_FAILED", { args, stderr: result.stderr, stdout: result.stdout });
}

function hasStructuredLintSummary(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!isRecord(parsed)) return false;
    if (parsed.ok === false) return false;
    if (isRecord(parsed.summary)) return true;
    return isRecord(parsed.data) && isRecord(parsed.data.summary);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function filesFromPorcelainStatus(stdout: string): string[] {
  return lines(stdout).map(fileFromPorcelainStatusLine).filter((path): path is string => Boolean(path));
}

function fileFromPorcelainStatusLine(line: string): string | undefined {
  if (line.length < 4) return undefined;
  const path = line.slice(3).trim();
  const renameSeparator = " -> ";
  return path.includes(renameSeparator) ? path.slice(path.lastIndexOf(renameSeparator) + renameSeparator.length) : path;
}
