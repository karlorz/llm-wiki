import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { runManagedWriteTransaction } from "../utils/managed-write-preflight.js";
import { renderRootIndex, writeRootIndexProjection } from "../utils/index-projection.js";
import { guardProtectedVaultWrite } from "../utils/protected-vault-write-guard.js";

export interface IndexRebuildInput {
  vault: string;
  write: boolean;
}

export interface IndexRebuildOutput {
  changed: boolean;
  dry_run: boolean;
  entry_count: number;
  duplicates_removed: number;
  ghosts_removed: string[];
  humanHint: string;
}

export async function runIndexRebuild(
  input: IndexRebuildInput,
): Promise<{ exitCode: number; result: Result<IndexRebuildOutput> }> {
  const projection = await renderRootIndex({ vault: input.vault });
  if (!projection.ok) {
    const code =
      projection.error === "SCHEME_REJECTED" ? ExitCode.SCHEME_REJECTED : ExitCode.VAULT_PATH_INVALID;
    return { exitCode: code, result: projection };
  }

  let current = "";
  try {
    current = readFileSync(join(input.vault, "index.md"), "utf8");
  } catch {
    current = "";
  }
  const changed = current !== projection.data.text;

  if (!input.write) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        changed,
        dry_run: true,
        entry_count: projection.data.entries.length,
        duplicates_removed: projection.data.duplicates_removed,
        ghosts_removed: projection.data.ghosts_removed,
        humanHint: changed
          ? `dry run: would rewrite index.md (${projection.data.entries.length} entries)`
          : `dry run: index.md already canonical (${projection.data.entries.length} entries)`,
      }),
    };
  }

  const guard = await guardProtectedVaultWrite({
    vault: input.vault,
    command: "index rebuild",
  });
  if (guard.blocked) {
    return { exitCode: guard.exitCode, result: guard.result };
  }

  return runManagedWriteTransaction({
    vault: input.vault,
    command: "index rebuild",
    allowImmutableRecord: false,
    mutate: async () => {
      if (!changed) {
        return {
          exitCode: ExitCode.OK,
          result: ok({
            changed: false,
            dry_run: false,
            entry_count: projection.data.entries.length,
            duplicates_removed: projection.data.duplicates_removed,
            ghosts_removed: projection.data.ghosts_removed,
            humanHint: `index.md already canonical (${projection.data.entries.length} entries)`,
          }),
        };
      }
      const written = await writeRootIndexProjection(input.vault, projection.data);
      if (!written.ok) {
        return { exitCode: ExitCode.WRITE_FAILED, result: written };
      }
      let installed = "";
      try {
        installed = readFileSync(join(input.vault, "index.md"), "utf8");
      } catch (error: unknown) {
        return {
          exitCode: ExitCode.WRITE_FAILED,
          result: err("WRITE_FAILED", { message: String(error) }),
        };
      }
      if (installed !== projection.data.text) {
        return {
          exitCode: ExitCode.WRITE_FAILED,
          result: err("WRITE_FAILED", { message: "installed index.md differs from projection" }),
        };
      }
      return {
        exitCode: ExitCode.OK,
        result: ok({
          changed: true,
          dry_run: false,
          entry_count: projection.data.entries.length,
          duplicates_removed: projection.data.duplicates_removed,
          ghosts_removed: projection.data.ghosts_removed,
          humanHint: `rewrote index.md (${projection.data.entries.length} entries)`,
        }),
      };
    },
  });
}
