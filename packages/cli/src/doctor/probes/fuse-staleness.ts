import { platform } from "node:os";
import {
  detectFuseMount,
  findRcloneMountPid,
  parseRcloneFlags,
  getRcloneArgs,
  extractRcloneFs,
  queryRcloneRC,
  parseDurationSeconds,
  type VfsStats,
} from "../../utils/s3-mount-health.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

const MAX_DIR_CACHE_TIME_SECONDS = 15 * 60; // 15m freshness envelope

export interface FuseStalenessDeps {
  platform?: () => NodeJS.Platform;
  detectFuseMount?: (vaultPath: string) => { mountPoint: string; fsType: string } | null;
  findRcloneMountPid?: () => number | null;
  parseRcloneFlags?: (pid: number) => Map<string, string>;
  getRcloneArgs?: (pid: number) => string[];
  queryRcloneRC?: (rcAddr: string, fs: string) => VfsStats | null;
}

function defaultFuseStalenessDeps(): Required<FuseStalenessDeps> {
  return {
    platform: () => platform(),
    detectFuseMount: (vp: string) => detectFuseMount(vp),
    findRcloneMountPid: () => findRcloneMountPid(),
    parseRcloneFlags: (pid: number) => parseRcloneFlags(pid),
    getRcloneArgs: (pid: number) => getRcloneArgs(pid),
    queryRcloneRC: (rcAddr: string, fs: string) => queryRcloneRC(rcAddr, fs),
  };
}

function formatDurationForHumans(seconds: number): string {
  if (!Number.isFinite(seconds)) return `${seconds}s`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

/**
 * Linux-only probe auditing rclone FUSE dir-cache freshness and VFS cache health.
 * Findings are advisory warnings (G11) and never change doctor's exit code.
 */
export function checkFuseStaleness(
  resolvedPath: string | undefined,
  deps: FuseStalenessDeps = {}
): CheckResult {
  const resolvedDeps = { ...defaultFuseStalenessDeps(), ...deps };
  const os = resolvedDeps.platform();

  if (os !== "linux") {
    return check(
      "pass",
      "fuse_staleness",
      "FUSE visibility freshness",
      `Non-Linux host (${os}) — check skipped`
    );
  }

  if (!resolvedPath) {
    return check(
      "pass",
      "fuse_staleness",
      "FUSE visibility freshness",
      "No vault path — check skipped"
    );
  }

  const fuse = resolvedDeps.detectFuseMount(resolvedPath);
  if (!fuse) {
    return check(
      "pass",
      "fuse_staleness",
      "FUSE visibility freshness",
      "local disk (non-FUSE) — check skipped"
    );
  }

  const pid = resolvedDeps.findRcloneMountPid();
  if (pid === null) {
    return check(
      "warn",
      "fuse_staleness",
      "FUSE visibility freshness",
      `S3 FUSE mount (${fuse.mountPoint}) but no rclone process found — cannot audit dir-cache freshness`
    );
  }

  const flags = resolvedDeps.parseRcloneFlags(pid);
  const rawDirCache = flags.get("--dir-cache-time");
  let dirCachePassed = true;
  let dirCacheDetail = "";

  if (!rawDirCache) {
    dirCacheDetail = "PID " + pid + ": --dir-cache-time not set (rclone default 5m, within <=15m SLA)";
  } else {
    const seconds = parseDurationSeconds(rawDirCache);
    if (seconds === null) {
      return check(
        "warn",
        "fuse_staleness",
        "FUSE visibility freshness",
        `PID ${pid}: could not parse --dir-cache-time=${rawDirCache}`
      );
    }
    if (seconds > MAX_DIR_CACHE_TIME_SECONDS) {
      dirCachePassed = false;
      dirCacheDetail = `PID ${pid}: --dir-cache-time=${rawDirCache} (${formatDurationForHumans(seconds)}) exceeds 15m SLA — external changes may remain invisible`;
    } else {
      dirCacheDetail = `PID ${pid}: --dir-cache-time=${rawDirCache} (${formatDurationForHumans(seconds)}), within <=15m SLA`;
    }
  }

  if (!dirCachePassed) {
    return check("warn", "fuse_staleness", "FUSE visibility freshness", dirCacheDetail);
  }

  // Check VFS cache RC stats if enabled
  if (flags.has("--rc")) {
    const rcAddr = flags.get("--rc-addr") || "127.0.0.1:5572";
    const args = resolvedDeps.getRcloneArgs(pid);
    const fs = extractRcloneFs(args) || "unknown:";
    const stats = resolvedDeps.queryRcloneRC(rcAddr, fs);

    if (stats) {
      if (stats.error) {
        return check("warn", "fuse_staleness", "FUSE visibility freshness", `${dirCacheDetail}; RC query error: ${stats.error}`);
      }
      const issues: string[] = [];
      if (stats.uploadsInProgress > 0) issues.push(`${stats.uploadsInProgress} upload(s) in progress`);
      if (stats.uploadsQueued > 10) issues.push(`${stats.uploadsQueued} upload(s) queued (backlog)`);
      if (stats.erroredFiles > 0) issues.push(`${stats.erroredFiles} errored file(s)`);
      if (stats.outOfSpace) issues.push("cache disk full");

      if (issues.length > 0) {
        return check(
          "warn",
          "fuse_staleness",
          "FUSE visibility freshness",
          `${dirCacheDetail}; VFS cache degradation: ${issues.join(", ")}`
        );
      }
    }
  }

  return check("pass", "fuse_staleness", "FUSE visibility freshness", dirCacheDetail);
}

export const fuseStalenessProbe: DoctorProbe = {
  id: "fuse_staleness",
  run(ctx: DoctorContext): CheckResult[] {
    return [checkFuseStaleness(ctx.resolvedPath)];
  },
};
