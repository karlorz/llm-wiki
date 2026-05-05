import { execSync } from "node:child_process";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { readFileSync } from "node:fs";
import { readCache, writeCache, type UpdateCache } from "../utils/auto-update.js";

export interface UpdateInput {
  home: string;
  distTag?: string;
}

export interface UpdateOutput {
  previousVersion: string;
  newVersion: string | null;
  wasAlreadyLatest: boolean;
  humanHint: string;
}

export async function runUpdate(
  input: UpdateInput
): Promise<{ exitCode: number; result: Result<UpdateOutput> }> {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  );
  const currentVersion: string = pkg.version;
  const tag = input.distTag ?? "beta";

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

  return {
    exitCode: ExitCode.OK,
    result: ok({
      previousVersion: currentVersion,
      newVersion: latest,
      wasAlreadyLatest: false,
      humanHint: `Updated skillwiki ${currentVersion} → ${latest}`,
    }),
  };
}
