import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
}

function candidateHelperPaths(input: VaultSyncPullHelperInput): string[] {
  const env = input.env ?? process.env;
  const paths: string[] = [];
  if (input.helperPath) paths.push(input.helperPath);
  if (env.SKILLWIKI_VAULT_SYNC_PULL_HELPER) paths.push(env.SKILLWIKI_VAULT_SYNC_PULL_HELPER);

  // Packaged CLI: dist/cli.js → dist/vault-sync/scripts/...
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // When running from dist/utils or src/utils
    paths.push(join(here, "..", "vault-sync", "scripts", "wiki-pull-with-auto-resolve.sh"));
    paths.push(join(here, "..", "..", "vault-sync", "scripts", "wiki-pull-with-auto-resolve.sh"));
    // Monorepo: packages/cli/src/utils → packages/vault-sync/scripts
    paths.push(join(here, "..", "..", "..", "vault-sync", "scripts", "wiki-pull-with-auto-resolve.sh"));
  } catch {
    /* import.meta.url unavailable in some test harnesses */
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
    return err("GIT_PULL_FAILED", { message: "canonical vault-sync pull helper not found" });
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
