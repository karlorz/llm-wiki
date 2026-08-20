import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanVaultConflictMarkers } from "../../utils/conflict-markers.js";
import { git } from "../../utils/git.js";
import {
  VAULT_HYGIENE_GENERATED_COMMIT_PATHS,
  VAULT_HYGIENE_GITIGNORE_PATTERNS,
  missingIgnorePatterns,
} from "../../utils/vault-hygiene-ignores.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function checkDotStoreClean(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "dsstore_clean", "No .DS_Store in raw/", "Cannot check — WIKI_PATH not resolved");
  }
  const rawDir = join(resolvedPath, "raw");
  if (!existsSync(rawDir)) {
    return check("pass", "dsstore_clean", "No .DS_Store in raw/", "raw/ directory not found — check skipped");
  }
  const found: string[] = [];
  (function walk(dir: string, rel: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        found.push(rel ? `${rel}/.DS_Store` : ".DS_Store");
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  })(rawDir, "");
  if (found.length === 0) {
    return check("pass", "dsstore_clean", "No .DS_Store in raw/", "No .DS_Store files found");
  }
  return check("info", "dsstore_clean", "No .DS_Store in raw/", `${found.length} .DS_Store file(s) found — remove with: find ${rawDir} -name .DS_Store -delete`);
}

function checkVaultConflictMarkers(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_conflict_markers", "Vault conflict markers", "No vault path — check skipped");
  }
  const findings = scanVaultConflictMarkers(resolvedPath);
  if (findings.length === 0) {
    return check("pass", "vault_conflict_markers", "Vault conflict markers", "No complete conflict-marker blocks");
  }
  const first = findings[0];
  const n = findings.length;
  const fileWord = n === 1 ? "file" : "files";
  return check(
    "error",
    "vault_conflict_markers",
    "Vault conflict markers",
    `${n} ${fileWord}, first: ${first.path}:${first.line}`,
  );
}

function githubSyncedGitRoot(gitRoot: string | undefined): { ok: true; gitRoot: string } | { ok: false; reason: string } {
  if (gitRoot === undefined) return { ok: false, reason: "No vault path — check skipped" };
  if (!existsSync(join(gitRoot, ".git"))) return { ok: false, reason: "Not a git repository — check skipped" };
  if (!git(gitRoot, ["remote"])) return { ok: false, reason: "No git remote — not GitHub-synced, check skipped" };
  return { ok: true, gitRoot };
}

function checkVaultGitignoreHygiene(synced: ReturnType<typeof githubSyncedGitRoot>): CheckResult {
  if (!synced.ok) {
    return check("pass", "vault_gitignore_hygiene", "Vault gitignore hygiene", synced.reason);
  }
  let content = "";
  try {
    content = readFileSync(join(synced.gitRoot, ".gitignore"), "utf8");
  } catch {
    content = "";
  }
  const missing = missingIgnorePatterns(content, VAULT_HYGIENE_GITIGNORE_PATTERNS);
  if (missing.length === 0) {
    return check("pass", "vault_gitignore_hygiene", "Vault gitignore hygiene", "Required local-scratch patterns present");
  }
  return check(
    "warn",
    "vault_gitignore_hygiene",
    "Vault gitignore hygiene",
    `Missing ${missing.join(", ")} — run \`skillwiki init --target <vault> --domain existing --write-gitignore\``,
  );
}

function checkTrackedHygieneScratch(synced: ReturnType<typeof githubSyncedGitRoot>): CheckResult {
  if (!synced.ok) {
    return check("pass", "vault_gitignore_tracked_scratch", "Tracked hygiene scratch", synced.reason);
  }
  const listed = git(synced.gitRoot, ["ls-files", "--", ...VAULT_HYGIENE_GENERATED_COMMIT_PATHS]);
  const files = listed ? listed.split("\n").filter(Boolean) : [];
  if (files.length === 0) {
    return check("pass", "vault_gitignore_tracked_scratch", "Tracked hygiene scratch", "No local-scratch paths tracked");
  }
  const sample = files.slice(0, 3).join(", ");
  const more = files.length > 3 ? ` (+${files.length - 3} more)` : "";
  return check(
    "warn",
    "vault_gitignore_tracked_scratch",
    "Tracked hygiene scratch",
    `${files.length} tracked scratch path(s) (${sample}${more}) — untrack with: git rm --cached -- ${files[0]}`,
  );
}

export const hygieneProbe: DoctorProbe = {
  id: "hygiene",
  run(ctx: DoctorContext): CheckResult[] {
    const synced = githubSyncedGitRoot(ctx.gitCheckPath);
    return [
      checkDotStoreClean(ctx.readOnlyScanRoot),
      checkVaultConflictMarkers(ctx.readOnlyScanRoot),
      checkVaultGitignoreHygiene(synced),
      checkTrackedHygieneScratch(synced),
    ];
  },
};
