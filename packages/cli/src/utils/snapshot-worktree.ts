import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDotenvText, type DotenvMap } from "./dotenv.js";

function readSkillWikiConfig(path: string): DotenvMap {
  try {
    return parseDotenvText(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function readSnapshotProfile(path: string): Record<string, string> {
  const allowed = new Set(["WIKI_GIT_WORKTREE", "SNAPSHOT_WORKTREE", "GIT_DIR"]);
  const profile: Record<string, string> = {};
  try {
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (allowed.has(key) && value.length > 0) profile[key] = value;
    }
  } catch {
    // Snapshot profile is optional; callers decide whether absence is fatal.
  }
  return profile;
}

/**
 * Resolve the exact configured snapshot worktree.
 *
 * Managed writes on protected snapshotters deliberately have no implicit
 * fallback: a missing convergence root must fail before mutation.
 */
export function resolveConfiguredSnapshotWorktree(home: string): string | undefined {
  if (!home) return undefined;
  const config = readSkillWikiConfig(join(home, ".skillwiki", ".env"));
  const explicit = config["vault_sync.snapshot_worktree"];
  if (explicit) return resolve(explicit);

  const snapshotProfile = config["vault_sync.snapshot_profile"];
  if (!snapshotProfile) return undefined;
  const profile = readSnapshotProfile(resolve(snapshotProfile));
  const fromProfile =
    profile.WIKI_GIT_WORKTREE
    ?? profile.SNAPSHOT_WORKTREE
    ?? profile.GIT_DIR;
  return fromProfile ? resolve(fromProfile) : undefined;
}
