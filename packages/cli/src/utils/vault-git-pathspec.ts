import { gitStrict } from "./git.js";
import { VAULT_HYGIENE_GENERATED_COMMIT_PATHS } from "./vault-hygiene-ignores.js";

export const VAULT_GENERATED_COMMIT_PATHS = VAULT_HYGIENE_GENERATED_COMMIT_PATHS;

export const VAULT_GENERATED_COMMIT_EXCLUDES = [
  ...VAULT_GENERATED_COMMIT_PATHS.map(path => `:!${path}`),
];

export const VAULT_COMMIT_PATHSPEC = [".", ...VAULT_GENERATED_COMMIT_EXCLUDES];

export function stageVaultContentChanges(vault: string): void {
  gitStrict(vault, ["add", "-A", "--", "."]);
  try {
    gitStrict(vault, ["reset", "HEAD", "--", ...VAULT_GENERATED_COMMIT_PATHS]);
  } catch (_e: unknown) {
    // Generated paths may not be staged in this repository.
  }
}
