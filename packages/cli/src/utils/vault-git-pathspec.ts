export const VAULT_GENERATED_COMMIT_PATHS = [
  ".skillwiki/last-op.json",
  ".skillwiki/memory",
  ".skillwiki/memory-topics.json",
];

export const VAULT_GENERATED_COMMIT_EXCLUDES = [
  ...VAULT_GENERATED_COMMIT_PATHS.map(path => `:!${path}`),
];

export const VAULT_COMMIT_PATHSPEC = [".", ...VAULT_GENERATED_COMMIT_EXCLUDES];
