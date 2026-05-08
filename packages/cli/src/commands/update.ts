import { execSync } from "node:child_process";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCache, writeCache, type UpdateCache } from "../utils/auto-update.js";
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

/** Re-install skills from the updated npm package. */
async function refreshInstalledSkills(target: string): Promise<{ warnings: string[]; refreshed: boolean }> {
  const skillsRoot = resolveGlobalSkillsRoot();
  if (!skillsRoot) {
    return { warnings: ["could not locate global skillwiki installation for skill refresh"], refreshed: false };
  }

  try {
    const result = await runInstall({ skillsRoot, target, dryRun: false, symlink: false });
    if (result.result.ok) {
      return { warnings: result.result.data.version_warnings, refreshed: true };
    }
    return { warnings: [`skill refresh failed: ${result.result.error}`], refreshed: false };
  } catch (e) {
    return { warnings: [`skill refresh error: ${String(e)}`], refreshed: false };
  }
}

export async function runUpdate(
  input: UpdateInput
): Promise<{ exitCode: number; result: Result<UpdateOutput> }> {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  const currentVersion: string = pkg.version;
  const tag = input.distTag ?? "beta";
  const target = join(input.home, ".claude", "skills");

  let latest: string;
  try {
    latest = execSync(`npm view skillwiki@${tag} version`, {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
  } catch (e) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { message: `Failed to query npm registry: ${String(e)}` }),
    };
  }

  // Update cache with the check result
  const cache: UpdateCache = {
    lastCheck: Date.now(),
    latestVersion: latest,
    currentVersion,
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
        humanHint: `Already on latest ${tag}: v${currentVersion}`,
      }),
    };
  }

  // Perform the update
  try {
    execSync(`npm install -g skillwiki@${tag}`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (e) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", { message: `npm install failed: ${String(e)}` }),
    };
  }

  writeCache(input.home, { ...cache, updateAppliedAt: Date.now() });

  // Re-install skills from updated package
  const installResult = await refreshInstalledSkills(target);
  const version_warnings = installResult.warnings;
  const skills_refreshed = installResult.refreshed;

  const hintLines = [
    `Updated skillwiki ${currentVersion} → ${latest}`,
    `skills refreshed: ${skills_refreshed}`,
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
      humanHint: hintLines.join("\n"),
    }),
  };
}
