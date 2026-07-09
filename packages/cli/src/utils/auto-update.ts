import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { semverGt } from "./semver.js";
import {
  AUTO_APPLY_DELAY_MS,
  CACHE_FILENAME,
  CHECK_INTERVAL_MS,
  DIST_TAG,
  ENV_DISABLE_KEY,
  CLI_DISABLE_FLAG,
  normalizeDistTag,
} from "./update-consts.js";

export interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
  currentVersion: string;
  distTag?: string;
  updateAppliedAt?: number;
  /** First time an update to `latestVersion` was observed (epoch ms). */
  firstSeenAt?: number;
  /** Scheduled auto-apply time = firstSeenAt + AUTO_APPLY_DELAY_MS (epoch ms). */
  autoApplyAt?: number;
}

export function cachePath(home: string): string {
  return join(home, ".skillwiki", CACHE_FILENAME);
}

/** Read the raw cache object without staleness/update derivation. Returns null on missing/unparseable. */
export function readCacheRaw(home: string): UpdateCache | null {
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
 * Resolve the scheduled auto-apply timestamp for a newly-seen update.
 * Returns the existing autoApplyAt if the latest version hasn't changed,
 * otherwise stamps firstSeenAt = now and computes autoApplyAt = now + delay.
 */
export function resolveAutoApplyAt(cache: UpdateCache | null, latestVersion: string, now: number = Date.now()): { firstSeenAt: number; autoApplyAt: number } {
  if (cache && cache.firstSeenAt && cache.latestVersion === latestVersion && cache.autoApplyAt) {
    return { firstSeenAt: cache.firstSeenAt, autoApplyAt: cache.autoApplyAt };
  }
  const firstSeenAt = now;
  return { firstSeenAt, autoApplyAt: firstSeenAt + AUTO_APPLY_DELAY_MS };
}

/**
 * Format remaining countdown until auto-apply as "Xh Ym" or "Ym".
 * Returns null if no update pending or already past the scheduled time.
 */
export function formatCountdown(autoApplyAt: number | undefined, now: number = Date.now()): string | null {
  if (!autoApplyAt) return null;
  const remainingMs = autoApplyAt - now;
  if (remainingMs <= 0) return null;
  const totalMin = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
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
export function latestFromCache(home: string, currentVersion: string): { hasUpdate: boolean; latest: string | null; distTag: string } {
  const { cache } = readCache(home);
  if (!cache || !cache.latestVersion) return { hasUpdate: false, latest: null, distTag: DIST_TAG };
  const distTag = normalizeDistTag(cache.distTag);
  return {
    hasUpdate: semverGt(cache.latestVersion, currentVersion),
    latest: cache.latestVersion,
    distTag,
  };
}

export function distTagFromCache(home: string): string {
  return normalizeDistTag(readCacheRaw(home)?.distTag);
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
 * that queries npm for the configured skillwiki dist-tag version and installs it
 * if newer than currentVersion and the auto-apply countdown has elapsed.
 * The current process is NOT blocked.
 *
 * Why 24h: balances freshness with avoiding npm registry load and user annoyance.
 * Why detached+unref: allows parent to exit immediately; child runs independently.
 *
 * Disable via NO_UPDATE_NOTIFIER env var, --no-update-notifier CLI flag, or NODE_ENV=test.
 */
export function triggerAutoUpdate(home: string, currentVersion: string): void {
  if (isDisabled()) return;

  // Read the cache once and thread it through both the spawn decision and the
  // notify path. This is a hot startup path (every CLI invoke), so a single
  // readFileSync here replaces the 2-5 redundant reads the prior version did.
  const { cache, isStale } = readCache(home);

  if (isStale) {
    const distTag = normalizeDistTag(cache?.distTag);
    // Resolve bg script as a sibling of this module. Both source (src/) and
    // bundled (dist/) layouts place auto-update-bg.js next to the importing file,
    // so a relative "./" URL is correct; "../" would escape dist/ and never exist.
    const bgScript = fileURLToPath(new URL("./auto-update-bg.js", import.meta.url));
    if (existsSync(bgScript)) {
      const child = spawn(process.execPath, [bgScript, home, currentVersion, distTag], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // Spawn failure is non-critical; silent to avoid CLI noise
      });
      child.unref();
    }
  }

  // Always surface a pending update as a stderr hint, whether or not a
  // background check was just spawned. This is the "any trigger" UX.
  notifyPendingUpdate(cache, currentVersion);
}

/**
 * Non-intrusive stderr notice when an update is pending but the auto-apply
 * countdown hasn't elapsed. Mirrors update-notifier's boxen one-liner UX.
 * Silent when no update is available, the countdown has elapsed (background
 * script will apply), or the notifier is disabled.
 *
 * Accepts a preloaded cache so callers on the hot path (triggerAutoUpdate)
 * avoid a second readFileSync.
 */
export function notifyPendingUpdate(cache: UpdateCache | null, currentVersion: string): void {
  if (isDisabled()) return;
  if (!cache || !cache.latestVersion) return;
  // Compare against the real running version, not the cached currentVersion,
  // so a stale cache doesn't report a phantom "update" to an older version.
  if (!semverGt(cache.latestVersion, currentVersion)) return;

  const { autoApplyAt } = resolveAutoApplyAt(cache, cache.latestVersion);
  const remaining = formatCountdown(autoApplyAt);
  // When remaining is null the countdown has elapsed; the background script
  // (or a future trigger) will apply it. Don't duplicate the notice.
  if (remaining === null) return;

  const distTag = normalizeDistTag(cache.distTag);
  process.stderr.write(
    `Update available: ${currentVersion} -> ${cache.latestVersion} (${distTag}). ` +
      `Auto-applying in ${remaining}. Run \`skillwiki update --tag ${distTag}\` now, ` +
      `or set NO_UPDATE_NOTIFIER=1 to opt out.\n`
  );
}
