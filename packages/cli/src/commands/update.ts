import { execSync } from "node:child_process";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { join } from "node:path";
import { readCache, writeCache, type UpdateCache, resolveAutoApplyAt } from "../utils/auto-update.js";
import { normalizeDistTag } from "../utils/update-consts.js";
import { readCliPackageJson } from "../utils/package-info.js";
import { runInstall } from "./install.js";

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
