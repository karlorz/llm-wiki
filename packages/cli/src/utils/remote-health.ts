/**
 * Availability model (offline-host resilience):
 *
 * | State            | Meaning |
 * |------------------|---------|
 * | local_vault      | Checkout is readable/writable with valid Git metadata |
 * | github_remote    | origin can be fetched/ls-remote for sync operations |
 * | s3_remote        | Configured rclone remote can be listed for push/snapshot |
 * | snapshotter_host | Fleet snapshotter SSH alias reachable (optional probe) |
 *
 * Local skillwiki reads/writes require only local_vault. Sync/promotion may degrade
 * when remotes fail; callers must report which dependency failed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export type RemoteReachability = "ok" | "unreachable" | "unknown";
export type SnapshotterReachability = RemoteReachability | "not_checked";

export interface RemoteHealthSnapshot {
  github: RemoteReachability;
  s3: RemoteReachability;
  snapshotter: SnapshotterReachability;
}

export const REMOTE_PROBE_TIMEOUT_MS = 3000;

export type ExecProbe = (file: string, args: string[], cwd?: string) => string;

const defaultExec: ExecProbe = (file, args, cwd) =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: REMOTE_PROBE_TIMEOUT_MS,
  }).trim();

/** Default rclone remote for wiki push (wiki-push.sh WIKI_REMOTE). */
export const DEFAULT_WIKI_S3_REMOTE = "seaweed-wiki:cloud/wiki";

/** Returns WIKI_REMOTE from ~/.skillwiki/.env when set; otherwise undefined (no implicit default). */
export function readWikiS3RemoteConfigured(home: string): string | undefined {
  try {
    const content = readFileSync(join(home, ".skillwiki", ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k === "WIKI_REMOTE" && v.length > 0) return v;
    }
  } catch {
    /* optional */
  }
  return undefined;
}

export function readWikiS3RemoteFromEnv(home: string): string {
  return readWikiS3RemoteConfigured(home) ?? DEFAULT_WIKI_S3_REMOTE;
}

export function probeGithubReachability(
  vaultPath: string,
  exec: ExecProbe = defaultExec,
): RemoteReachability {
  if (!existsSync(join(vaultPath, ".git"))) return "unknown";
  try {
    exec("git", ["remote", "get-url", "origin"], vaultPath);
  } catch {
    return "unknown";
  }
  try {
    const out = exec("git", ["ls-remote", "origin", "refs/heads/main"], vaultPath);
    if (out.length > 0) return "ok";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export function probeS3Reachability(
  remote: string,
  exec: ExecProbe = defaultExec,
): RemoteReachability {
  if (!remote) return "unknown";
  try {
    exec("rclone", ["lsf", remote, "--max-depth", "1", "--files-only"]);
    return "ok";
  } catch {
    return "unreachable";
  }
}

export function probeSnapshotterSsh(
  sshAlias: string,
  exec: ExecProbe = defaultExec,
): RemoteReachability {
  if (!sshAlias) return "unknown";
  try {
    exec("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=3",
      "-o", "StrictHostKeyChecking=accept-new",
      sshAlias,
      "true",
    ]);
    return "ok";
  } catch {
    return "unreachable";
  }
}

export function buildDegradedReasons(health: RemoteHealthSnapshot): string[] {
  const reasons: string[] = [];
  if (health.github === "unreachable") reasons.push("github_remote_unreachable");
  if (health.s3 === "unreachable") reasons.push("s3_remote_unreachable");
  if (health.snapshotter === "unreachable") reasons.push("snapshotter_host_unreachable");
  return reasons;
}

export function probeRemoteHealth(input: {
  vaultPath: string;
  home: string;
  s3Remote?: string;
  snapshotterAlias?: string;
  checkSnapshotter?: boolean;
  exec?: ExecProbe;
}): RemoteHealthSnapshot {
  const exec = input.exec ?? defaultExec;
  const github = probeGithubReachability(input.vaultPath, exec);
  const s3Remote = input.s3Remote ?? readWikiS3RemoteFromEnv(input.home);
  const s3 = probeS3Reachability(s3Remote, exec);
  let snapshotter: SnapshotterReachability = "not_checked";
  if (input.checkSnapshotter && input.snapshotterAlias) {
    snapshotter = probeSnapshotterSsh(input.snapshotterAlias, exec);
  }
  return { github, s3, snapshotter };
}