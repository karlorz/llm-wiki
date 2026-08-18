import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  findRcloneMountPid,
  parseRcloneFlags,
  getRcloneArgs,
  extractRcloneFs,
  getRcloneVersion,
  queryRcloneRC,
  detectFuseMount,
  writeTest,
  parseDurationSeconds,
  FLAG_THRESHOLDS,
  MIN_RCLONE_VERSION,
} from "../../utils/s3-mount-health.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function checkS3MountPerf(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "s3_mount_perf", "S3 mount performance", "No vault path — check skipped");
  }

  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_mount_perf", "S3 mount performance", "local disk");
  }
  const mountPoint = fuse.mountPoint;

  const conceptsDir = join(resolvedPath, "concepts");
  if (!existsSync(conceptsDir)) {
    return check("pass", "s3_mount_perf", "S3 mount performance", `S3 FUSE mount (${mountPoint}), no concepts/ to benchmark`);
  }

  const start = Date.now();
  let timedOut = false;
  try {
    execSync(`rg -l "." "${conceptsDir}"`, {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    if (e.killed || (e.status === null && e.signal === "SIGTERM")) {
      timedOut = true;
    } else if (e.code === "ENOENT") {
      return check(
        "info",
        "s3_mount_perf",
        "S3 mount performance",
        `S3 FUSE mount (${mountPoint}) — rg not found at runtime, benchmark skipped`
      );
    }
    // rg exits 1 on no matches (or 2 on error) — both still completed, use elapsed time
  }
  const elapsed = (Date.now() - start) / 1000;

  if (timedOut || elapsed >= 3) {
    return check(
      "warn",
      "s3_mount_perf",
      "S3 mount performance",
      `S3 FUSE mount (${mountPoint}) with cold cache (rg scan: >3s). Vault scans may exceed 60s. Consider running wiki-cache-warm or checking rclone-wiki.service.`
    );
  }

  return check(
    "pass",
    "s3_mount_perf",
    "S3 mount performance",
    `S3 FUSE mount, cache warm (rg scan: ${elapsed.toFixed(3)}s)`
  );
}

const MAX_DIR_CACHE_TIME_SECONDS = 15 * 60;

function formatDurationForHumans(seconds: number): string {
  if (!Number.isFinite(seconds)) return `${seconds}s`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

/** Check freshness envelope for cross-device S3 visibility (dir-cache-time). */
function checkS3MountFreshness(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "s3_mount_freshness", "S3 visibility freshness", "No vault path — check skipped");
  }

  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_mount_freshness", "S3 visibility freshness", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `S3 FUSE mount (${fuse.mountPoint}) but no rclone process found — cannot audit --dir-cache-time`
    );
  }

  const flags = parseRcloneFlags(pid);
  if (flags.size === 0) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `rclone PID ${pid} found but could not parse flags`
    );
  }

  const raw = flags.get("--dir-cache-time");
  if (!raw) {
    return check(
      "pass",
      "s3_mount_freshness",
      "S3 visibility freshness",
      "PID " + pid + ": --dir-cache-time not set (rclone default 5m, within <=15m SLA)"
    );
  }

  const seconds = parseDurationSeconds(raw);
  if (seconds === null) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `PID ${pid}: could not parse --dir-cache-time=${raw}`
    );
  }

  if (seconds > MAX_DIR_CACHE_TIME_SECONDS) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `PID ${pid}: --dir-cache-time=${raw} (${formatDurationForHumans(seconds)}) exceeds 15m SLA — external S3 changes may remain invisible`
    );
  }

  return check(
    "pass",
    "s3_mount_freshness",
    "S3 visibility freshness",
    `PID ${pid}: --dir-cache-time=${raw} (${formatDurationForHumans(seconds)}), within <=15m SLA`
  );
}

// ── S3 mount health checks (A–E) ────────────────────────────

/** Check A: rclone flag audit — are critical VFS flags set to safe values? */
function checkRcloneFlagAudit(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "rclone_flags", "rclone VFS flags", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "rclone_flags", "rclone VFS flags", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check("warn", "rclone_flags", "rclone VFS flags", `S3 FUSE mount (${fuse.mountPoint}) but no rclone process found — cannot audit flags`);
  }

  const flags = parseRcloneFlags(pid);
  if (flags.size === 0) {
    return check("warn", "rclone_flags", "rclone VFS flags", `rclone PID ${pid} found but could not parse flags`);
  }

  const warnings: string[] = [];
  for (const [flag, threshold] of Object.entries(FLAG_THRESHOLDS)) {
    const raw = flags.get(flag);
    if (raw === undefined) {
      warnings.push(`${flag} not set (default may be unsafe)`);
      continue;
    }
    const inSeconds = parseDurationSeconds(raw);
    if (inSeconds === null) continue;
    const thresholdSec = threshold.unit === "h" ? threshold.min * 3600 : threshold.unit === "m" ? threshold.min * 60 : threshold.min;
    if (inSeconds < thresholdSec) {
      warnings.push(`${flag}=${raw} (recommended ≥${threshold.min}${threshold.unit})`);
    }
  }

  // Bonus: check for --vfs-cache-mode
  const cacheMode = flags.get("--vfs-cache-mode");
  if (!cacheMode) {
    warnings.push("--vfs-cache-mode not set (recommended: full)");
  } else if (cacheMode !== "full") {
    warnings.push(`--vfs-cache-mode=${cacheMode} (recommended: full)`);
  }

  // Bonus: check for --log-file
  if (!flags.has("--log-file")) {
    warnings.push("--log-file not set — no rclone error log configured");
  }

  if (warnings.length > 0) {
    return check("warn", "rclone_flags", "rclone VFS flags", warnings.join("; "));
  }
  return check("pass", "rclone_flags", "rclone VFS flags", `PID ${pid}: all critical flags at safe values`);
}

/** Check B: rclone version — does it support --vfs-write-wait? */
function checkRcloneVersion(resolvedPath: string | undefined, vaultSyncInstalled: boolean): CheckResult {
  if (!resolvedPath && !vaultSyncInstalled) {
    return check("pass", "rclone_version", "rclone version", "No vault path — check skipped");
  }
  const fuse = resolvedPath ? detectFuseMount(resolvedPath) : null;
  if (!fuse && !vaultSyncInstalled) {
    return check("pass", "rclone_version", "rclone version", "local disk — check skipped");
  }

  const ver = getRcloneVersion();
  if (!ver) {
    return check("warn", "rclone_version", "rclone version", "rclone not found on PATH — cannot verify version");
  }

  const min = MIN_RCLONE_VERSION;
  const tooOld = ver.major < min.major ||
    (ver.major === min.major && ver.minor < min.minor) ||
    (ver.major === min.major && ver.minor === min.minor && ver.patch < min.patch);

  if (tooOld) {
    return check(
      "warn",
      "rclone_version",
      "rclone version",
      `${ver.raw} — upgrade to ≥v${min.major}.${min.minor}.${min.patch} for --vfs-write-wait support (current version may silently ignore this flag)`
    );
  }
  return check("pass", "rclone_version", "rclone version", ver.raw);
}

/** Check C: write-then-read test — can the vault actually write and read files? */
function checkWriteTest(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "s3_write_test", "S3 write test", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_write_test", "S3 write test", "local disk — check skipped");
  }

  const conceptsDir = join(resolvedPath, "concepts");
  if (!existsSync(conceptsDir)) {
    return check("pass", "s3_write_test", "S3 write test", "no concepts/ dir to test — check skipped");
  }

  const result = writeTest(conceptsDir);

  if (result.success) {
    const totalMs = result.writeMs + result.readMs;
    if (totalMs > 3000) {
      return check("warn", "s3_write_test", "S3 write test",
        `write+read ${totalMs}ms (write ${result.writeMs}ms, read ${result.readMs}ms, ${result.size}B) — S3 mount is slow`);
    }
    return check("pass", "s3_write_test", "S3 write test",
      `write+read ${totalMs}ms (write ${result.writeMs}ms, read ${result.readMs}ms)`);
  }
  return check("warn", "s3_write_test", "S3 write test",
    `${result.error} — S3 mount may have a stale FUSE handle or write-back failure`);
}

/** Check D: VFS cache health via rclone RC endpoint. */
function checkVfsCacheHealth(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "vfs_cache_health", "VFS cache health", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "vfs_cache_health", "VFS cache health", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check("warn", "vfs_cache_health", "VFS cache health", "no rclone process found — cannot query VFS stats");
  }

  const flags = parseRcloneFlags(pid);
  const rcAddr = flags.get("--rc-addr") || "127.0.0.1:5572";

  // Only query if --rc flag is present
  if (!flags.has("--rc")) {
    return check("info", "vfs_cache_health", "VFS cache health",
      `rclone RC not enabled — add --rc --rc-addr ${rcAddr} to enable cache health monitoring`);
  }

  // Extract the rclone remote path from the cmdline (e.g., "cloud:cloud/wiki")
  const args = getRcloneArgs(pid);
  const fs = extractRcloneFs(args) || "unknown:";

  const stats = queryRcloneRC(rcAddr, fs || "unknown:");
  if (!stats) {
    return check("warn", "vfs_cache_health", "VFS cache health",
      `RC endpoint ${rcAddr} unreachable — is rclone --rc enabled?`);
  }
  if (stats.error) {
    return check("warn", "vfs_cache_health", "VFS cache health", stats.error);
  }

  const issues: string[] = [];
  if (stats.uploadsInProgress > 0) issues.push(`${stats.uploadsInProgress} upload(s) in progress`);
  if (stats.uploadsQueued > 10) issues.push(`${stats.uploadsQueued} upload(s) queued (backlog)`);
  if (stats.erroredFiles > 0) issues.push(`${stats.erroredFiles} errored file(s)`);
  if (stats.outOfSpace) issues.push("cache disk full");

  if (issues.length > 0) {
    return check("warn", "vfs_cache_health", "VFS cache health",
      `${stats.files} files, ${stats.bytesUsed} bytes — ${issues.join("; ")}`);
  }
  return check("pass", "vfs_cache_health", "VFS cache health",
    `${stats.files} files, ${(stats.bytesUsed / 1024 / 1024).toFixed(1)}MB — clean (0 errored, 0 pending)`);
}

export const s3MountHealthProbe: DoctorProbe = {
  id: "s3_mount_health",
  run(ctx: DoctorContext): CheckResult[] {
    return [
      checkS3MountPerf(ctx.resolvedPath),
      checkS3MountFreshness(ctx.resolvedPath),
      checkRcloneFlagAudit(ctx.resolvedPath),
      checkRcloneVersion(ctx.resolvedPath, ctx.vsConfig.installed),
      checkWriteTest(ctx.resolvedPath),
      checkVfsCacheHealth(ctx.resolvedPath),
    ];
  },
};
