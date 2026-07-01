import { join, resolve } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { scanVault } from "../utils/vault.js";

export interface ResolveVaultInput {
  vault?: string;
  wiki?: string;
  home?: string;
}

/** Resolve and validate a vault root (SCHEMA.md present). No shell, no arbitrary paths without validation. */
export async function resolveMcpVault(input: ResolveVaultInput): Promise<Result<{ vault: string; source: string }>> {
  const home = input.home ?? process.env.HOME ?? "";
  let vaultPath: string;
  let source = "resolved";

  if (input.vault !== undefined && input.vault.length > 0) {
    vaultPath = resolve(input.vault);
    source = "flag";
  } else {
    const r = await resolveRuntimePath({
      flag: undefined,
      envValue: process.env.WIKI_PATH,
      wikiEnv: process.env.WIKI,
      home,
      wiki: input.wiki,
    });
    if (!r.ok) return r;
    vaultPath = resolve(r.data.path);
    source = r.data.source;
  }

  const scan = await scanVault(vaultPath);
  if (!scan.ok) {
    return err("VAULT_PATH_INVALID", { root: vaultPath, reason: scan.detail ?? scan.error });
  }
  return ok({ vault: vaultPath, source });
}

export function defaultGraphOut(vault: string): string {
  return join(vault, ".skillwiki", "graph.json");
}