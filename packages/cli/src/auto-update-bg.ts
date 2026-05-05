#!/usr/bin/env node
/**
 * Background auto-update script for skillwiki.
 *
 * Spawned as a detached child process by triggerAutoUpdate().
 * Queries npm for the latest skillwiki@beta version, compares
 * with the current version, and installs the update if newer.
 *
 * Args: <home> <currentVersion>
 */
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { semverGt } from "./utils/semver.js";

const home = process.argv[2];
const currentVersion = process.argv[3];

if (!home || !currentVersion) process.exit(0);

const cacheFile = join(home, ".skillwiki", ".update-cache.json");

// Bail out after 30s to avoid zombie background processes
setTimeout(() => process.exit(0), 30_000);

try {
  const latest = execSync("npm view skillwiki@beta version", {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();

  // Write cache regardless of whether update is needed
  mkdirSync(dirname(cacheFile), { recursive: true });
  const cache = {
    lastCheck: Date.now(),
    latestVersion: latest,
    currentVersion,
  };

  // Only auto-update if latest is strictly greater (avoids downgrades)
  if (semverGt(latest, currentVersion)) {
    execSync("npm install -g skillwiki@beta", {
      stdio: "ignore",
      timeout: 60_000,
    });
    writeFileSync(cacheFile, JSON.stringify({ ...cache, updateAppliedAt: Date.now() }, null, 2));
  } else {
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  }
} catch {
  // Network error, npm not found, permission denied — write stale cache to avoid retry storm
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ lastCheck: Date.now(), latestVersion: "", currentVersion }, null, 2));
  } catch {
    // Can't even write cache — give up silently
  }
}

process.exit(0);
