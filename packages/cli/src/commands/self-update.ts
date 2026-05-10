import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { join } from "node:path";

/** Default path to local source checkout (the llm-wiki repo root). */
const DEFAULT_SOURCE_ROOT_SUFFIX = "/Desktop/code/llm-wiki";

export interface SelfUpdateInput {
  home: string;
  check: boolean;
  /** Override the local source checkout root (for testing). */
  sourceRoot?: string;
}

export interface SelfUpdateOutput {
  source: "local" | "npm";
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  newVersion?: string;
  humanHint: string;
}

export async function runSelfUpdate(
  input: SelfUpdateInput
): Promise<{ exitCode: number; result: Result<SelfUpdateOutput> }> {
  // Current running version
  const currentVersion: string = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ).version;

  // Resolve the local source checkout root
  const sourceRoot = input.sourceRoot ?? `${input.home}${DEFAULT_SOURCE_ROOT_SUFFIX}`;
  const localPkgPath = join(sourceRoot, "packages", "cli", "package.json");
  const hasLocalSource = existsSync(localPkgPath);

  // ---check mode: compare versions without updating
  if (input.check) {
    let availableVersion: string | null = null;
    let source: "local" | "npm";

    if (hasLocalSource) {
      source = "local";
      try {
        availableVersion = JSON.parse(readFileSync(localPkgPath, "utf8")).version ?? null;
      } catch {
        availableVersion = null;
      }
    } else {
      source = "npm";
      try {
        availableVersion = execSync("npm view skillwiki@beta version", {
          encoding: "utf8",
          timeout: 15_000,
        }).trim();
      } catch (e: unknown) {
        return {
          exitCode: ExitCode.INTERNAL_ERROR,
          result: err("PREFLIGHT_FAILED", { message: `Failed to query npm registry: ${String(e)}` }),
        };
      }
    }

    const updateAvailable = availableVersion !== null && availableVersion !== currentVersion;
    const hint = updateAvailable
      ? `Update available: ${currentVersion} → ${availableVersion} (${source})`
      : `Already up to date: v${currentVersion} (${source})`;

    return {
      exitCode: ExitCode.OK,
      result: ok({
        source,
        currentVersion,
        availableVersion,
        updateAvailable,
        humanHint: hint,
      }),
    };
  }

  // Perform update
  if (hasLocalSource) {
    // Build from local source
    try {
      execSync("npm run build -w packages/cli", {
        cwd: sourceRoot,
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (e: unknown) {
      return {
        exitCode: ExitCode.INTERNAL_ERROR,
        result: err("BUILD_FAILED", { message: `Build failed: ${String(e)}` }),
      };
    }

    // Link the built package globally
    try {
      execSync("npm link ./packages/cli", {
        cwd: sourceRoot,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (e: unknown) {
      return {
        exitCode: ExitCode.INTERNAL_ERROR,
        result: err("LINK_FAILED", { message: `npm link failed: ${String(e)}` }),
      };
    }

    // Report the new version from source
    const newVersion = (() => {
      try {
        return JSON.parse(readFileSync(localPkgPath, "utf8")).version ?? "unknown";
      } catch {
        return "unknown";
      }
    })();

    return {
      exitCode: ExitCode.OK,
      result: ok({
        source: "local",
        currentVersion,
        availableVersion: newVersion,
        updateAvailable: newVersion !== currentVersion,
        newVersion,
        humanHint: `Built and linked from local source: v${newVersion}`,
      }),
    };
  }

  // No local source — install from npm (prefer beta channel)
  let latestVersion: string;
  try {
    latestVersion = execSync("npm view skillwiki@beta version", {
      encoding: "utf8",
      timeout: 15_000,
    }).trim();
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.INTERNAL_ERROR,
      result: err("PREFLIGHT_FAILED", { message: `Failed to query npm registry: ${String(e)}` }),
    };
  }

  if (latestVersion === currentVersion) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        source: "npm",
        currentVersion,
        availableVersion: latestVersion,
        updateAvailable: false,
        humanHint: `Already on latest beta: v${currentVersion}`,
      }),
    };
  }

  try {
    execSync("npm install -g skillwiki@beta", {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (e: unknown) {
    return {
      exitCode: ExitCode.INTERNAL_ERROR,
      result: err("INSTALL_FAILED", { message: `npm install failed: ${String(e)}` }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      source: "npm",
      currentVersion,
      availableVersion: latestVersion,
      updateAvailable: true,
      newVersion: latestVersion,
      humanHint: `Updated skillwiki ${currentVersion} → ${latestVersion} via npm@beta`,
    }),
  };
}
