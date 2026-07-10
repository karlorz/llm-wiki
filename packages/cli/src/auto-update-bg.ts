#!/usr/bin/env node
/**
 * Background auto-update script for skillwiki.
 *
 * Spawned as a detached child process by triggerAutoUpdate().
 * Queries npm for the configured skillwiki dist-tag version, compares
 * with the current version, and installs the update if newer AND the
 * auto-apply countdown has elapsed (firstSeenAt + AUTO_APPLY_DELAY_MS).
 *
 * Args: <home> <currentVersion> <distTag>
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { semverGt } from "./utils/semver.js";
import {
  AUTO_APPLY_DELAY_MS,
  normalizeDistTag,
} from "./utils/update-consts.js";
import {
  cachePath,
  readCacheRaw,
  resolveAutoApplyAt,
  writeCache,
  type UpdateCache,
} from "./utils/auto-update.js";

const home = process.argv[2];
const currentVersion = process.argv[3];
const distTag = normalizeDistTag(process.argv[4]);

if (!home || !currentVersion) process.exit(0);

const cacheFile = cachePath(home);

// Bail out after 30s to avoid zombie background processes
setTimeout(() => process.exit(0), 30_000);

try {
  const latest = execSync(`npm view skillwiki@${distTag} version`, {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();

  // Write cache regardless of whether update is needed
  mkdirSync(dirname(cacheFile), { recursive: true });

  const prior = readCacheRaw(home);
  const { firstSeenAt, autoApplyAt } = resolveAutoApplyAt(prior, latest);
  const cache: UpdateCache = {
    lastCheck: Date.now(),
    latestVersion: latest,
    currentVersion,
    distTag,
    firstSeenAt,
    autoApplyAt,
  };

  // Only auto-update if the channel version is strictly greater (avoids downgrades)
  if (semverGt(latest, currentVersion)) {
    if (Date.now() < autoApplyAt) {
      // Countdown still active - persist state and wait. The next stale
      // check (after CHECK_INTERVAL_MS) or a fresh invoke past autoApplyAt
      // will apply it. This mirrors openclaw's stable-rollout deferral.
      writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
      process.exit(0);
    }
    execSync(`npm install -g skillwiki@${distTag}`, {
      stdio: "ignore",
      timeout: 60_000,
    });
    writeCache(home, { ...cache, updateAppliedAt: Date.now() });
  } else {
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  }
} catch {
  // Network error, npm not found, permission denied - write stale cache to avoid retry storm.
  // Preserve firstSeenAt/autoApplyAt from the prior cache so a transient failure does
  // not reset the countdown window the user was already counting down against.
  try {
    const prior = readCacheRaw(home);
    const staleCache: UpdateCache = {
      lastCheck: Date.now(),
      latestVersion: "",
      currentVersion,
      distTag,
      ...(prior?.firstSeenAt ? { firstSeenAt: prior.firstSeenAt } : {}),
      ...(prior?.autoApplyAt ? { autoApplyAt: prior.autoApplyAt } : {}),
    };
    writeCache(home, staleCache);
  } catch {
    // Can't even write cache - give up silently
  }
}

process.exit(0);
