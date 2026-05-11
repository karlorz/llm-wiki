import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { semverGt } from "./semver.js";
import {
  CACHE_FILENAME,
  CHECK_INTERVAL_MS,
  ENV_DISABLE_KEY,
  CLI_DISABLE_FLAG,
} from "./update-consts.js";

export interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
  currentVersion: string;
  updateAppliedAt?: number;
}

export function cachePath(home: string): string {
  return join(home, ".skillwiki", CACHE_FILENAME);
}

function readCacheRaw(home: string): UpdateCache | null {
  try {
    const raw = readFileSync(cachePath(home), "utf8");
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

/** Read cache and check if an update is available. Returns null if no cache. */
export function readCache(home: string): { cache: UpdateCache | null; hasUpdate: boolean; isStale: boolean } {
  const cache = readCacheRaw(home);
  if (!cache) return { cache: null, hasUpdate: false, isStale: true };

  const isStale = Date.now() - cache.lastCheck >= CHECK_INTERVAL_MS;
  const hasUpdate = !!cache.latestVersion && semverGt(cache.latestVersion, cache.currentVersion);
  return { cache, hasUpdate, isStale };
}

export function writeCache(home: string, cache: UpdateCache): void {
  const p = cachePath(home);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2));
}

/**
 * Check if background update should run (cache is stale).
 * Combines cache read and staleness check in one operation.
 */
export function needsCheck(home: string): boolean {
  return readCache(home).isStale;
}

/**
 * Check if cached latest version is newer than current.
 * Uses semantic comparison, not lexical.
 */
export function latestFromCache(home: string, currentVersion: string): { hasUpdate: boolean; latest: string | null } {
  const { cache } = readCache(home);
  if (!cache || !cache.latestVersion) return { hasUpdate: false, latest: null };
  return {
    hasUpdate: semverGt(cache.latestVersion, currentVersion),
    latest: cache.latestVersion,
  };
}

function isDisabled(): boolean {
  return !!(
    process.env[ENV_DISABLE_KEY] ||
    process.env.NODE_ENV === "test" ||
    process.argv.includes(CLI_DISABLE_FLAG)
  );
}

/**
 * Trigger a background auto-update check. Spawns a detached child process
 * that queries npm for the latest skillwiki@latest version and installs it
 * if newer than currentVersion. The current process is NOT blocked.
 *
 * Why 24h: balances freshness with avoiding npm registry load and user annoyance.
 * Why detached+unref: allows parent to exit immediately; child runs independently.
 *
 * Disable via NO_UPDATE_NOTIFIER env var, --no-update-notifier CLI flag, or NODE_ENV=test.
 */
export function triggerAutoUpdate(home: string, currentVersion: string): void {
  if (isDisabled()) return;

  const { isStale } = readCache(home);
  if (!isStale) return;

  const bgScript = new URL("../auto-update-bg.js", import.meta.url).pathname;
  if (!existsSync(bgScript)) return;

  const child = spawn(process.execPath, [bgScript, home, currentVersion], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Spawn failure is non-critical; silent to avoid CLI noise
  });
  child.unref();
}
