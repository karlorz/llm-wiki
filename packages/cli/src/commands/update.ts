import { execSync } from "node:child_process";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { join } from "node:path";
import { readCache, writeCache, type UpdateCache, resolveAutoApplyAt } from "../utils/auto-update.js";
import { normalizeDistTag } from "../utils/update-consts.js";
import { readCliPackageJson } from "../utils/package-info.js";
import { runInstall } from "./install.js";

function parseCoreSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

function isAtLeast(parsed: { major: number; minor: number; patch: number }, major: number, minor: number, patch: number): boolean {
  return parsed.major > major
    || (parsed.major === major && parsed.minor > minor)
    || (parsed.major === major && parsed.minor === minor && parsed.patch >= patch);
}

function isBelow(parsed: { major: number; minor: number; patch: number }, major: number, minor: number, patch: number): boolean {
  return !isAtLeast(parsed, major, minor, patch);
}

/** True when previous < 0.10.1 and new >= 0.10.1. */
export function needs0101Migration(previousVersion: string, newVersion: string): boolean {
  const p = parseCoreSemver(previousVersion);
  const n = parseCoreSemver(newVersion);
  if (!p || !n) return false;
  return isBelow(p, 0, 10, 1) && isAtLeast(n, 0, 10, 1);
}

/** True when previous < 0.10.70 (first HTTP MCP production family) and new >= 0.10.70. */
export function needsHttpMcpMigration(previousVersion: string, newVersion: string): boolean {
  const p = parseCoreSemver(previousVersion);
  const n = parseCoreSemver(newVersion);
  if (!p || !n) return false;
  return isBelow(p, 0, 10, 70) && isAtLeast(n, 0, 10, 70);
}

/** Migration notes when upgrading across known floors (0.10.1 helper + HTTP MCP cutover). */
export function migrationNotesForUpgrade(previousVersion: string, newVersion: string): string[] {
  const notes: string[] = [];
  if (needs0101Migration(previousVersion, newVersion)) {
    notes.push(
      "Migration 0.10.1:",
      "- pull helper resolves from dist/ + host vault-sync install",
      "- run: skillwiki doctor",
      "- if managed writes blocked: skillwiki sync journal list",
      "- then: skillwiki sync journal clear-stale --dry-run",
      "- legacy override: SKILLWIKI_VAULT_SYNC_PULL_HELPER=<path-to-wiki-pull-with-auto-resolve.sh>",
    );
  }
  if (needsHttpMcpMigration(previousVersion, newVersion)) {
    notes.push(
      "Migration HTTP MCP:",
      "- upgrade the plugin channel, then start a new session (plugin instructions do not hot-swap)",
      "- run: skillwiki doctor --check-mcp",
      "- frozen-leaf hosts write via HTTP MCP only; do not local-write raw/transcripts/ or vault git",
    );
  }
  return notes;
}

export interface UpdateInput {
  home: string;
  distTag?: string;
}

export interface UpdateOutput {
  previousVersion: string;
  newVersion: string | null;
  wasAlreadyLatest: boolean;
  version_warnings: string[];
  skills_refreshed: boolean;
  deferred_to_plugin: boolean;
  humanHint: string;
}

/** Determine the global npm skillwiki skills directory. */
function resolveGlobalSkillsRoot(): string | null {
  try {
    const globalRoot = execSync("npm root -g", {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return join(globalRoot, "skillwiki", "skills");
  } catch {
    return null;
  }
}

/**
 * Re-install skills from the updated npm package.
 * When the skillwiki@llm-wiki plugin channel is the active skills provider,
 * defers to it instead of recreating ~/.claude/skills/ copies that
 * `skillwiki doctor` would flag as duplicates.
 */
async function refreshInstalledSkills(home: string, target: string): Promise<{ warnings: string[]; refreshed: boolean; deferred_to_plugin: boolean }> {
  const skillsRoot = resolveGlobalSkillsRoot();
  if (!skillsRoot) {
    return { warnings: ["could not locate global skillwiki installation for skill refresh"], refreshed: false, deferred_to_plugin: false };
  }

  try {
    const result = await runInstall({ skillsRoot, target, dryRun: false, symlink: false, home, force: false });
    if (result.result.ok) {
      return {
        warnings: result.result.data.version_warnings,
        refreshed: !result.result.data.deferred_to_plugin,
        deferred_to_plugin: result.result.data.deferred_to_plugin,
      };
    }
    return { warnings: [`skill refresh failed: ${result.result.error}`], refreshed: false, deferred_to_plugin: false };
  } catch (e: unknown) {
    return { warnings: [`skill refresh error: ${String(e)}`], refreshed: false, deferred_to_plugin: false };
  }
}

export async function runUpdate(
  input: UpdateInput
): Promise<{ exitCode: number; result: Result<UpdateOutput> }> {
  const pkg = readCliPackageJson();
  const currentVersion: string = pkg.version;
  const tag = normalizeDistTag(input.distTag);
  const target = join(input.home, ".claude", "skills");

  let latest: string;
  try {
    latest = execSync(`npm view skillwiki@${tag} version`, {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { message: `Failed to query npm registry: ${String(e)}` }),
    };
  }

  // Update cache with the check result
  const { firstSeenAt, autoApplyAt } = resolveAutoApplyAt(readCache(input.home).cache, latest);
  const cache: UpdateCache = {
    lastCheck: Date.now(),
    latestVersion: latest,
    currentVersion,
    distTag: tag,
    firstSeenAt,
    autoApplyAt,
  };

  if (latest === currentVersion) {
    writeCache(input.home, cache);
    return {
      exitCode: ExitCode.OK,
      result: ok({
        previousVersion: currentVersion,
        newVersion: null,
        wasAlreadyLatest: true,
        version_warnings: [],
        skills_refreshed: false,
        deferred_to_plugin: false,
        humanHint: `Already on npm@${tag}: v${currentVersion}`,
      }),
    };
  }

  // Perform the update
  try {
    execSync(`npm install -g skillwiki@${tag}`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { message: `npm install failed: ${String(e)}` }),
    };
  }

  writeCache(input.home, { ...cache, updateAppliedAt: Date.now() });

  // Re-install skills from updated package
  const installResult = await refreshInstalledSkills(input.home, target);
  const version_warnings = installResult.warnings;
  const skills_refreshed = installResult.refreshed;
  const deferred_to_plugin = installResult.deferred_to_plugin;

  const hintLines = [
    `Updated skillwiki ${currentVersion} → ${latest} via npm@${tag}`,
    deferred_to_plugin
      ? `skills deferred to plugin channel (skillwiki@llm-wiki)`
      : `skills refreshed: ${skills_refreshed}`,
  ];
  if (version_warnings.length > 0) {
    hintLines.push(`version warnings: ${version_warnings.length}`);
    for (const w of version_warnings) hintLines.push(`  ${w}`);
  }
  for (const line of migrationNotesForUpgrade(currentVersion, latest)) {
    hintLines.push(line);
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      previousVersion: currentVersion,
      newVersion: latest,
      wasAlreadyLatest: false,
      version_warnings,
      skills_refreshed,
      deferred_to_plugin,
      humanHint: hintLines.join("\n"),
    }),
  };
}
