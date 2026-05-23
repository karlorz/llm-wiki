/**
 * Cross-platform S3 mount health utilities for `skillwiki doctor`.
 *
 * Works on Linux (ARM64/AMD64) and macOS (ARM64/AMD64).
 * All functions are designed to fail gracefully — if rclone isn't installed
 * or the vault is local disk, they return null/undefined rather than throwing.
 *
 * Platform detection:
 *   - Linux:   /proc/mounts, /proc/<pid>/cmdline, pgrep, which
 *   - macOS:   mount(8), ps(1), pgrep (Homebrew), which
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readFileSync as readFile } from "node:fs";
import { join } from "node:path";

const OS = platform(); // "linux" | "darwin"

// ─── rclone discovery ────────────────────────────────────────

/** Find the PID of a running rclone mount process, or null if none. */
export function findRcloneMountPid(): number | null {
  try {
    // pgrep is available on Linux (procps) and macOS (Homebrew procps).
    // Match only "rclone mount" — not "rclone sync" or "rclone rc".
    const out = execSync("pgrep -f 'rclone.*mount'", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const pids = out.split("\n").filter(Boolean);
    if (pids.length === 0) return null;
    return parseInt(pids[0], 10);
  } catch {
    // pgrep not available or no match — try ps fallback
    try {
      const out = execSync("ps aux", { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"] });
      for (const line of out.split("\n")) {
        if (line.includes("rclone") && line.includes("mount") && !line.includes("grep")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) return parseInt(parts[1], 10);
        }
      }
    } catch { /* ps failed too */ }
    return null;
  }
}

/** Parse rclone command-line flags into a Map. */
export function parseRcloneFlags(pid: number): Map<string, string> {
  const flags = new Map<string, string>();
  try {
    const args = getRcloneArgs(pid);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--") && arg.includes("=")) {
        // --flag=value format
        const eq = arg.indexOf("=");
        flags.set(arg.slice(0, eq), arg.slice(eq + 1));
      } else if (arg.startsWith("--")) {
        // --flag value format (rclone's native format) or boolean flag
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          flags.set(arg, next);
          i++; // consume the value
        } else {
          // Boolean flag — mark as present with empty value
          flags.set(arg, "");
        }
      }
    }
  } catch { /* process may have exited between discovery and read */ }
  return flags;
}

// ─── rclone version ──────────────────────────────────────────

export interface RcloneVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Parse "rclone version" output. Returns null if rclone not installed. */
export function getRcloneVersion(): RcloneVersion | null {
  try {
    const out = execSync("rclone version", {
      encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    });
    // First line: "rclone v1.74.1" or "rclone v1.60.1-DEV"
    const match = out.match(/rclone\s+v(\d+)\.(\d+)\.(\d+)/i);
    if (!match) return null;
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      raw: out.split("\n")[0].trim(),
    };
  } catch {
    return null;
  }
}

// ─── rclone RC query ─────────────────────────────────────────

export interface VfsStats {
  erroredFiles: number;
  uploadsInProgress: number;
  uploadsQueued: number;
  outOfSpace: boolean;
  bytesUsed: number;
  files: number;
  totalSize: string;
  /** null if RC not configured or query failed */
  error?: string;
}

/**
 * Extract the rclone remote path from mount arguments.
 * Example cmdline: "mount cloud:cloud/wiki /root/wiki" → "cloud:cloud/wiki"
 */
export function extractRcloneFs(args: string[]): string | null {
  let foundMount = false;
  for (const arg of args) {
    if (arg === "mount") { foundMount = true; continue; }
    if (foundMount && arg.includes(":") && !arg.startsWith("-") && !arg.startsWith("/")) {
      return arg;
    }
  }
  return null;
}

/** Get the full rclone argument list for a PID. */
export function getRcloneArgs(pid: number): string[] {
  try {
    if (OS === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`);
      return new TextDecoder().decode(raw).split("\0").filter(Boolean);
    } else {
      const out = execSync(`ps -o args= -p ${pid}`, {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return out.split(/\s+/);
    }
  } catch {
    return [];
  }
}

/** Query rclone RC endpoint for VFS stats. Returns null if RC not reachable. */
export function queryRcloneRC(rcAddr: string, fs: string): VfsStats | null {
  try {
    const payload = JSON.stringify({ fs });
    const out = execSync(
      `curl -s --max-time 3 -X POST "http://${rcAddr}/vfs/stats" -H "Content-Type: application/json" -d '${payload}' 2>/dev/null`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    );
    if (!out.trim()) return null;
    const data = JSON.parse(out);
    if (data.status && data.status >= 400) {
      return { error: data.error || `RC error (status ${data.status})`, erroredFiles: 0, uploadsInProgress: 0, uploadsQueued: 0, outOfSpace: false, bytesUsed: 0, files: 0, totalSize: "unknown" };
    }
    const dc = data.diskCache || {};
    return {
      erroredFiles: dc.erroredFiles ?? 0,
      uploadsInProgress: dc.uploadsInProgress ?? 0,
      uploadsQueued: dc.uploadsQueued ?? 0,
      outOfSpace: dc.outOfSpace ?? false,
      bytesUsed: dc.bytesUsed ?? 0,
      files: dc.files ?? 0,
      totalSize: data.totalSize || "unknown",
    };
  } catch {
    return { error: "RC endpoint unreachable", erroredFiles: 0, uploadsInProgress: 0, uploadsQueued: 0, outOfSpace: false, bytesUsed: 0, files: 0, totalSize: "unknown" };
  }
}

// ─── FUSE mount detection (cross-platform) ───────────────────

/**
 * Detect if a path lives on a FUSE mount.
 * Returns `{ mountPoint, fsType }` or null if local disk.
 */
export function detectFuseMount(vaultPath: string): { mountPoint: string; fsType: string } | null {
  try {
    if (OS === "linux") {
      const mounts = readFileSync("/proc/mounts", "utf8");
      let best: { point: string; fs: string } | null = null;
      for (const line of mounts.split("\n")) {
        const parts = line.split(" ");
        if (parts.length < 3) continue;
        const point = parts[1];
        const fs = parts[2];
        if (vaultPath.startsWith(point) && (!best || point.length > best.point.length)) {
          best = { point, fs };
        }
      }
      if (best && best.fs.includes("fuse")) return { mountPoint: best.point, fsType: best.fs };
    } else if (OS === "darwin") {
      const out = execSync("mount", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      let best: { point: string; fsType: string } | null = null;
      for (const line of out.split("\n")) {
        const match = line.match(/^(\S+) on (\S+) \((.*?)\)/);
        if (!match) continue;
        const point = match[2];
        const opts = match[3];
        if (opts.includes("fuse") && vaultPath.startsWith(point) && (!best || point.length > best.point.length)) {
          best = { point, fsType: `fuse.${match[1].split(":")[0] || "unknown"}` };
        }
      }
      if (best) return { mountPoint: best.point, fsType: best.fsType };
    }
  } catch { /* non-root may not read /proc/mounts */ }
  return null;
}

// ─── Write-then-read test ────────────────────────────────────

export interface WriteTestResult {
  success: boolean;
  writeMs: number;
  readMs: number;
  /** Bytes written/read */
  size: number;
  error?: string;
}

/**
 * Write a small file to the vault, flush, read it back, verify, then delete.
 * This is the only check that actually exercises the full write path through
 * the FUSE mount → rclone VFS buffer → S3 upload queue.
 *
 * The test file is named `.doctor-write-test-<pid>.tmp` to avoid collision
 * and to signal that it's safe to delete if left behind by a crash.
 */
export function writeTest(dir: string): WriteTestResult {
  const testFile = join(dir, `.doctor-write-test-${process.pid}.tmp`);
  const payload = `skillwiki doctor write test — ${Date.now()} — ${Math.random().toString(36).slice(2)}`;
  const start = Date.now();

  // Write
  try {
    writeFileSync(testFile, payload, "utf8");
  } catch (e: any) {
    return { success: false, writeMs: Date.now() - start, readMs: 0, size: 0, error: `write failed: ${e.message}` };
  }
  const writeMs = Date.now() - start;

  // Read back
  const readStart = Date.now();
  try {
    const back = readFile(testFile, "utf8");
    const readMs = Date.now() - readStart;

    if (back !== payload) {
      // Clean up before returning
      try { unlinkSync(testFile); } catch { /* best effort */ }
      return { success: false, writeMs, readMs, size: Buffer.byteLength(payload, "utf8"), error: "content mismatch — wrote and read-back differ" };
    }
  } catch (e: any) {
    try { unlinkSync(testFile); } catch { /* best effort */ }
    return { success: false, writeMs, readMs: Date.now() - readStart, size: 0, error: `read failed: ${e.message}` };
  }

  // Clean up
  try { unlinkSync(testFile); } catch { /* best effort */ }

  return { success: true, writeMs, readMs: Date.now() - readStart, size: Buffer.byteLength(payload, "utf8") };
}

// ─── rclone flag safety thresholds ───────────────────────────

/** Minimum recommended values for critical rclone VFS flags. */
export const FLAG_THRESHOLDS: Record<string, { min: number; unit: string; label: string }> = {
  "--vfs-write-back": { min: 15, unit: "s", label: "VFS write-back window" },
  "--vfs-write-wait": { min: 10, unit: "s", label: "VFS write-wait" },
  "--vfs-cache-max-age": { min: 24, unit: "h", label: "VFS cache max age" },
};

/** Minimum rclone version that supports --vfs-write-wait. */
export const MIN_RCLONE_VERSION = { major: 1, minor: 65, patch: 0 };
