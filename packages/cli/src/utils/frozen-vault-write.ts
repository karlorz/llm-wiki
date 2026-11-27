import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ExitCode, type ErrResult } from "@skillwiki/shared";

export function frozenVaultWriteRefusal(
  vault: string,
  command: string,
): { exitCode: number; result: ErrResult } | null {
  const roots = new Set([resolve(vault)]);
  let existing = resolve(vault);
  while (true) {
    try {
      roots.add(realpathSync(existing));
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  for (const root of roots) {
    let current = root;
    while (true) {
      const marker = join(current, ".WIKI_GIT_FROZEN");
      try {
        try {
          if (!statSync(current).isDirectory()) {
            throw Object.assign(new Error("Vault ancestor is not a directory"), { code: "ENOTDIR" });
          }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        lstatSync(marker);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return {
            exitCode: ExitCode.PREFLIGHT_FAILED,
            result: err("PREFLIGHT_FAILED", {
              reason: "frozen-marker-unreadable", command, marker,
              guidance: "Verify the vault write authority before retrying. Use advertised HTTP MCP tools for managed writes.",
            }),
          };
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
        continue;
      }
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "frozen-leaf", command, marker,
          guidance: "This vault is a read-only mirror. Use advertised HTTP MCP tools for managed writes; retain unpublished drafts outside the vault.",
        }),
      };
    }
  }
  return null;
}
