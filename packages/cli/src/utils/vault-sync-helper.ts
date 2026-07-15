import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "@skillwiki/shared";
import { git } from "./git.js";

export interface VaultSyncPullReceipt {
  before_oid: string;
  after_oid: string;
  changed: boolean;
  helper_path: string;
}

export interface VaultSyncPullHelperInput {
  vault: string;
  remote?: string;
  branch?: string;
  lockToken?: string;
  helperPath?: string;
  env?: Record<string, string | undefined>;
  /** Override dirname(import.meta.url) for packaged-layout tests. */
  moduleDir?: string;
  /** Override home directory for host-install fallback tests. */
  home?: string;
}

const HELPER_NAME = "wiki-pull-with-auto-resolve.sh";

/**
 * Build ordered candidate paths for the canonical vault-sync pull helper.
 * Order: explicit arg → env override → dist-adjacent → relative layouts → host install.
 */
export function candidateHelperPaths(input: VaultSyncPullHelperInput = { vault: "" }): string[] {
  const env = input.env ?? process.env;
  const paths: string[] = [];
  if (input.helperPath) paths.push(input.helperPath);
  if (env.SKILLWIKI_VAULT_SYNC_PULL_HELPER) paths.push(env.SKILLWIKI_VAULT_SYNC_PULL_HELPER);

  let here: string | undefined = input.moduleDir;
  if (!here) {
    try {
      here = dirname(fileURLToPath(import.meta.url));
    } catch {
      here = undefined;
    }
  }

  if (here) {
    // Packaged npm: dist/cli.js or dist/chunk-*.js → dist/vault-sync/scripts/...
    paths.push(join(here, "vault-sync", "scripts", HELPER_NAME));
    // When running from dist/utils or src/utils
    paths.push(join(here, "..", "vault-sync", "scripts", HELPER_NAME));
    paths.push(join(here, "..", "..", "vault-sync", "scripts", HELPER_NAME));
    // Monorepo: packages/cli/src/utils → packages/vault-sync/scripts
    paths.push(join(here, "..", "..", "..", "vault-sync", "scripts", HELPER_NAME));
  }

  const home = input.home ?? env.HOME ?? env.USERPROFILE ?? (() => {
    try {
      return homedir();
    } catch {
      return undefined;
    }
  })();

  if (home) {
    const xdg = env.XDG_DATA_HOME;
    const isDarwin = platform() === "darwin";
    if (isDarwin) {
      paths.push(join(home, "Library", "Application Support", "vault-sync", "bin", HELPER_NAME));
    }
    paths.push(join(xdg || join(home, ".local", "share"), "vault-sync", "bin", HELPER_NAME));
    // Also probe the non-native host layout so cross-platform tests and mixed installs work.
    if (!isDarwin) {
      paths.push(join(home, "Library", "Application Support", "vault-sync", "bin", HELPER_NAME));
    }
  }

  return paths;
}

export function resolveVaultSyncPullHelper(input: VaultSyncPullHelperInput): string | null {
  for (const p of candidateHelperPaths(input)) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

export async function runVaultSyncPullHelper(
  input: VaultSyncPullHelperInput,
): Promise<Result<VaultSyncPullReceipt>> {
  const helperPath = resolveVaultSyncPullHelper(input);
  if (!helperPath) {
    const tried = candidateHelperPaths(input).filter(Boolean);
    return err("GIT_PULL_FAILED", {
      message:
        "canonical vault-sync pull helper not found; run skillwiki doctor; " +
        "install skillwiki@0.10.1+ or set SKILLWIKI_VAULT_SYNC_PULL_HELPER; " +
        "host install: ~/Library/Application Support/vault-sync/bin or ~/.local/share/vault-sync/bin",
      tried_paths: tried.slice(0, 12),
    });
  }

  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  const beforeOid = git(input.vault, ["rev-parse", "HEAD"]);
  if (!beforeOid) {
    return err("GIT_PULL_FAILED", { message: "could not read HEAD before pull" });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.env ?? {}),
    WIKI_DIR: input.vault,
  };
  if (input.lockToken) {
    env.VAULT_SYNC_MANAGED_LOCK_TOKEN = input.lockToken;
  }

  const result = spawnSync("bash", [helperPath, remote, branch], {
    env,
    encoding: "utf8",
    cwd: input.vault,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const status = result.status ?? 1;

  if (status === 2) {
    return err("PREFLIGHT_FAILED", { reason: "existing-handoff", output, helper_path: helperPath });
  }
  if (status !== 0) {
    return err("GIT_PULL_FAILED", {
      message: result.error ? String(result.error) : `helper exited ${status}`,
      output,
      helper_path: helperPath,
    });
  }

  const afterOid = git(input.vault, ["rev-parse", "HEAD"]);
  if (!afterOid) {
    return err("GIT_PULL_FAILED", { message: "could not read HEAD after pull", helper_path: helperPath });
  }

  return ok({
    before_oid: beforeOid,
    after_oid: afterOid,
    changed: beforeOid !== afterOid,
    helper_path: helperPath,
  });
}
