import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { mergeTaxonomyConflict } from "../parsers/taxonomy.js";
import { git } from "../utils/git.js";
import { renderRootIndex } from "../utils/index-projection.js";
import { mergeLogConflictStages } from "../utils/log-merge.js";
import { renderProjectIndex } from "./project-index.js";

export type DerivedArtifactClass = "log" | "root-index" | "project-index" | "taxonomy" | "unknown";

export interface DerivedConflictResolutionInput {
  vault: string;
  operationId: string;
}

export interface DerivedConflictResolutionOutput {
  resolved: boolean;
  resolved_paths: string[];
  unknown_paths: string[];
  rolled_back: boolean;
  humanHint: string;
}

export function classifyDerivedPath(path: string): DerivedArtifactClass {
  if (path === "index.md") return "root-index";
  if (path === "SCHEMA.md") return "taxonomy";
  if (path === "log.md" || path.endsWith("/log.md")) return "log";
  if (/^projects\/[^/]+\/knowledge\.md$/.test(path)) return "project-index";
  return "unknown";
}

function journalPath(vault: string, operationId: string): string | null {
  const gitPath = git(vault, ["rev-parse", "--git-path", `vault-sync/operations/${operationId}.env`]);
  if (!gitPath) return null;
  return gitPath.startsWith("/") ? gitPath : join(vault, gitPath);
}

function readJournalFields(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function showStage(vault: string, stage: 1 | 2 | 3, path: string): string | null {
  try {
    return execFileSync("git", ["show", `:${stage}:${path}`], {
      cwd: vault,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function stageOid(vault: string, stage: 1 | 2 | 3, path: string): string {
  return git(vault, ["rev-parse", `:${stage}:${path}`]);
}

function unmergedPaths(vault: string): string[] {
  const raw = git(vault, ["diff", "--name-only", "--diff-filter=U"]);
  return raw ? raw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

function verifyOperation(vault: string, operationId: string): Result<{ phase: string }> {
  const path = journalPath(vault, operationId);
  if (!path || !existsSync(path)) {
    return err("PREFLIGHT_FAILED", { reason: "missing-operation-journal", operation_id: operationId });
  }
  const fields = readJournalFields(path);
  if (fields.operation_id !== operationId) {
    return err("PREFLIGHT_FAILED", { reason: "operation-id-mismatch", operation_id: operationId });
  }
  if (fields.handoff === "1") {
    return err("PREFLIGHT_FAILED", { reason: "operation-handoff", operation_id: operationId });
  }
  const phase = fields.phase ?? "";
  if (phase !== "rebasing" && phase !== "restoring") {
    return err("PREFLIGHT_FAILED", { reason: "operation-phase", phase, operation_id: operationId });
  }
  const currentGitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  const journalGitDir = fields.worktree_git_dir ?? "";
  if (journalGitDir && currentGitDir && journalGitDir !== currentGitDir) {
    return err("PREFLIGHT_FAILED", { reason: "worktree-mismatch", operation_id: operationId });
  }
  if (!journalGitDir && unmergedPaths(vault).length === 0) {
    return err("PREFLIGHT_FAILED", { reason: "legacy-journal-without-unmerged", operation_id: operationId });
  }
  return ok({ phase });
}

async function resolveOne(
  vault: string,
  path: string,
  klass: DerivedArtifactClass,
): Promise<Result<string>> {
  if (klass === "root-index") {
    const rendered = await renderRootIndex({ vault });
    if (!rendered.ok) return rendered;
    return ok(rendered.data.text);
  }
  if (klass === "taxonomy") {
    const base = showStage(vault, 1, path) ?? "";
    const ours = showStage(vault, 2, path);
    const theirs = showStage(vault, 3, path);
    if (ours === null || theirs === null) {
      return err("WRITE_FAILED", { path, message: "missing taxonomy stages" });
    }
    const merged = mergeTaxonomyConflict(base, ours, theirs);
    if (!merged.ok) return merged;
    return ok(merged.data.text);
  }
  if (klass === "log") {
    const base = showStage(vault, 1, path) ?? "";
    const ours = showStage(vault, 2, path) ?? "";
    const theirs = showStage(vault, 3, path) ?? "";
    const merged = mergeLogConflictStages({ base, ours, theirs });
    if (!merged.ok) return merged;
    return ok(merged.data.text);
  }
  if (klass === "project-index") {
    const slug = path.replace(/^projects\//, "").replace(/\/knowledge\.md$/, "");
    const rendered = await renderProjectIndex(vault, slug);
    if (!rendered.ok) return rendered;
    return ok(rendered.data.text);
  }
  return err("SCHEME_REJECTED", { path, reason: "unknown-derived-class" });
}

function rollbackPath(vault: string, path: string, stage2: string, stage3: string): boolean {
  try {
    execFileSync("git", ["checkout", "--conflict=merge", "--", path], {
      cwd: vault,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return false;
  }
  const s2 = stageOid(vault, 2, path);
  const s3 = stageOid(vault, 3, path);
  return s2 === stage2 && s3 === stage3;
}

// Re-export helper for tests that import conflict marker scan by path
function hasMarkers(path: string, text: string): boolean {
  // local inline scan to avoid private export issues
  const lines = text.split(/\r?\n/);
  let open = false;
  let sep = false;
  for (const line of lines) {
    if (line.startsWith("<<<<<<< ")) {
      open = true;
      sep = false;
      continue;
    }
    if (line === "=======" && open) {
      sep = true;
      continue;
    }
    if (line.startsWith(">>>>>>> ") && open && sep) return true;
    if (line.startsWith(">>>>>>> ")) {
      open = false;
      sep = false;
    }
  }
  return false;
}

export async function runDerivedConflictResolution(
  input: DerivedConflictResolutionInput,
): Promise<{ exitCode: number; result: Result<DerivedConflictResolutionOutput> }> {
  const vault = input.vault;
  const verified = verifyOperation(vault, input.operationId);
  if (!verified.ok) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", verified.detail),
    };
  }

  const paths = unmergedPaths(vault);
  if (paths.length === 0) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        resolved: true,
        resolved_paths: [],
        unknown_paths: [],
        rolled_back: false,
        humanHint: "no unmerged paths",
      }),
    };
  }

  const classes = paths.map((p) => ({ path: p, klass: classifyDerivedPath(p) }));
  const unknown = classes.filter((c) => c.klass === "unknown").map((c) => c.path);
  if (unknown.length > 0) {
    return {
      exitCode: ExitCode.SYNC_PULL_FAILED,
      result: ok({
        resolved: false,
        resolved_paths: [],
        unknown_paths: unknown,
        rolled_back: false,
        humanHint: `review-required: unknown conflict paths ${unknown.join(", ")}`,
      }),
    };
  }

  const snapshots = new Map<string, { stage2: string; stage3: string }>();
  for (const { path } of classes) {
    snapshots.set(path, {
      stage2: stageOid(vault, 2, path),
      stage3: stageOid(vault, 3, path),
    });
  }

  const staged: string[] = [];
  try {
    for (const { path, klass } of classes) {
      const resolved = await resolveOne(vault, path, klass);
      if (!resolved.ok) throw new Error(`${path}: ${resolved.error}`);
      if (hasMarkers(path, resolved.data)) {
        throw new Error(`${path}: conflict markers remain after resolve`);
      }
      writeFileSync(join(vault, path), resolved.data, "utf8");
      execFileSync("git", ["add", "--", path], { cwd: vault, stdio: ["pipe", "pipe", "pipe"] });
      staged.push(path);
    }

    const remaining = unmergedPaths(vault);
    if (remaining.length > 0) {
      throw new Error(`still unmerged: ${remaining.join(",")}`);
    }

    return {
      exitCode: ExitCode.OK,
      result: ok({
        resolved: true,
        resolved_paths: staged,
        unknown_paths: [],
        rolled_back: false,
        humanHint: `resolved ${staged.length} derived path(s)`,
      }),
    };
  } catch (error: unknown) {
    let rolled = true;
    for (const path of staged) {
      const snap = snapshots.get(path);
      if (!snap || !rollbackPath(vault, path, snap.stage2, snap.stage3)) {
        rolled = false;
      }
    }
    // Also restore not-yet-staged paths that may have been partially written
    for (const { path } of classes) {
      if (staged.includes(path)) continue;
      const snap = snapshots.get(path);
      if (snap) rollbackPath(vault, path, snap.stage2, snap.stage3);
    }
    return {
      exitCode: ExitCode.SYNC_PULL_FAILED,
      result: ok({
        resolved: false,
        resolved_paths: [],
        unknown_paths: [],
        rolled_back: rolled,
        humanHint: `derived resolve failed: ${String(error)}`,
      }),
    };
  }
}

