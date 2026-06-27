import { gitStrict } from "./git.js";

export const VAULT_GENERATED_COMMIT_PATHS = [
  ".skillwiki/last-op.json",
  ".skillwiki/memory",
  ".skillwiki/memory-topics.json",
];

export const VAULT_GENERATED_COMMIT_EXCLUDES = [
  ...VAULT_GENERATED_COMMIT_PATHS.map(path => `:!${path}`),
];

export const VAULT_COMMIT_PATHSPEC = [".", ...VAULT_GENERATED_COMMIT_EXCLUDES];

export function stageVaultContentChanges(vault: string): void {
  gitStrict(vault, ["add", "-A", "--", "."]);
  for (const generatedPath of VAULT_GENERATED_COMMIT_PATHS) {
    try {
      gitStrict(vault, ["reset", "HEAD", "--", generatedPath]);
    } catch (_e: unknown) {
      // Generated paths may not be staged in this repository.
    }
  }
}
