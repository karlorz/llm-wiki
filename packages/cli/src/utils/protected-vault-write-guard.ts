import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { err, ExitCode, type ErrResult } from "@skillwiki/shared";
import { loadFleetManifestAndHost } from "../commands/fleet.js";
import { resolveRuntimePath } from "./wiki-path.js";

export interface ProtectedVaultWriteGuardInput {
  vault: string;
  command: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  osHostname?: string;
  user?: string;
}

export interface ProtectedVaultWriteGuardBlocked {
  blocked: true;
  exitCode: number;
  result: ErrResult;
}

export interface ProtectedVaultWriteGuardAllowed {
  blocked: false;
}

export type ProtectedVaultWriteGuardResult =
  | ProtectedVaultWriteGuardBlocked
  | ProtectedVaultWriteGuardAllowed;

export async function guardProtectedVaultWrite(
  input: ProtectedVaultWriteGuardInput
): Promise<ProtectedVaultWriteGuardResult> {
  const env = input.env ?? process.env;
  const home = input.home ?? process.env.HOME ?? "";
  const cwd = input.cwd ?? process.cwd();
  const liveVaultPath = await resolveLiveVaultPath({ env, home, cwd });
  const load = await loadFleetManifestAndHost({
    vault: liveVaultPath ?? input.vault,
    hostId: input.hostId,
    env,
    home,
    cwd,
    osHostname: input.osHostname ?? process.env.HOSTNAME,
    user: input.user ?? process.env.USER,
  });

  if (!load?.hostId || load.identityStatus !== "known") {
    return { blocked: false };
  }

  const host = load.manifest.hosts[load.hostId];
  if (!host || host.role !== "snapshotter" || host.protected !== true) {
    return { blocked: false };
  }

  const snapshotWorktree = resolveSnapshotWorktree(home);
  const targetVault = resolvePath(input.vault);
  const canonicalLiveVault = liveVaultPath ? resolvePath(liveVaultPath) : undefined;
  const canonicalSnapshotWorktree = snapshotWorktree ? resolvePath(snapshotWorktree) : undefined;

  if (canonicalLiveVault && targetVault === canonicalLiveVault) {
    return { blocked: false };
  }

  if (canonicalSnapshotWorktree && targetVault === canonicalSnapshotWorktree) {
    return {
      blocked: true,
      exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED,
      result: err("PROTECTED_SNAPSHOTTER_WRITE_BLOCKED", {
        host_id: load.hostId,
        command: input.command,
        reason: `refusing mutation of snapshot worktree '${canonicalSnapshotWorktree}' on protected snapshotter host '${load.hostId}'`,
        guidance: canonicalLiveVault
          ? `Use the live vault path '${canonicalLiveVault}' for authoring. Keep snapshot worktrees read-only except explicit snapshot maintenance.`
          : "Use the live skillwiki vault path for authoring. Keep snapshot worktrees read-only except explicit snapshot maintenance.",
      }),
    };
  }

  if (canonicalLiveVault && targetVault !== canonicalLiveVault) {
    return {
      blocked: true,
      exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED,
      result: err("PROTECTED_SNAPSHOTTER_WRITE_BLOCKED", {
        host_id: load.hostId,
        command: input.command,
        reason: `refusing vault mutation outside the live vault path '${canonicalLiveVault}' on protected snapshotter host '${load.hostId}'`,
        guidance: "Use the resolved live skillwiki vault path for authoring. Keep alternate vault roots and snapshot worktrees read-only unless explicitly approved.",
      }),
    };
  }

  return { blocked: false };
}

async function resolveLiveVaultPath(input: {
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
}): Promise<string | undefined> {
  const resolved = await resolveRuntimePath({
    flag: undefined,
    envValue: input.env.WIKI_PATH,
    wikiEnv: input.env.WIKI,
    home: input.home,
    cwd: input.cwd,
  });
  return resolved.ok ? resolved.data.path : undefined;
}

function resolveSnapshotWorktree(home: string): string | undefined {
  const skillwikiEnv = join(home, ".skillwiki", ".env");
  const explicitWorktree = readEnvKey(skillwikiEnv, ["vault_sync.snapshot_worktree"]);
  if (explicitWorktree) return explicitWorktree;

  const snapshotProfile = readEnvKey(skillwikiEnv, ["vault_sync.snapshot_profile"]);
  if (snapshotProfile) {
    const fromProfile = readEnvKey(snapshotProfile, ["WIKI_GIT_WORKTREE", "SNAPSHOT_WORKTREE", "GIT_DIR"]);
    if (fromProfile) return fromProfile;
  }

  return "/root/wiki-git";
}

function readEnvKey(path: string, keys: string[]): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!keys.includes(key)) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value.length > 0) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
