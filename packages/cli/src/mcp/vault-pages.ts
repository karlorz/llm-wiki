import { scanVault } from "../utils/vault.js";
import { ok, ExitCode, type Result } from "@skillwiki/shared";

export type VaultPageLayer = "typed" | "raw" | "work" | "all";

export interface VaultPagesListInput {
  vault: string;
  layer?: VaultPageLayer;
  offset?: number;
  limit?: number;
}

export interface VaultPagesListOutput {
  layer: VaultPageLayer;
  total: number;
  offset: number;
  limit: number;
  paths: string[];
  truncated: boolean;
}

export async function listVaultPages(
  input: VaultPagesListInput,
): Promise<{ exitCode: number; result: Result<VaultPagesListOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const layer = input.layer ?? "typed";
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 50), 200);

  let paths: string[] = [];
  if (layer === "typed" || layer === "all") {
    paths.push(...scan.data.typedKnowledge.map((p) => p.relPath));
  }
  if (layer === "raw" || layer === "all") {
    paths.push(...scan.data.raw.map((p) => p.relPath));
  }
  if (layer === "work" || layer === "all") {
    paths.push(...scan.data.workItems.map((p) => p.relPath));
  }
  paths.sort();
  const page = paths.slice(offset, offset + limit);

  return {
    exitCode: ExitCode.OK,
    result: ok({
      layer,
      total: paths.length,
      offset,
      limit,
      paths: page,
      truncated: offset + page.length < paths.length,
    }),
  };
}