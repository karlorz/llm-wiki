/**
 * Vault-local scratch vs published operational cache.
 *
 * Local scratch must stay out of GitHub and S3. Do not gitignore all of
 * `.skillwiki/` — `session-brief.{md,json}` and `agent-memory-trends/` are
 * published deterministic caches.
 *
 * Work-complete journals (`.skillwiki/work-complete/{opId}.env`) are crash
 * resume only. Completion SSOT is the work item + `meta/log-events/`.
 */

export const VAULT_HYGIENE_GITIGNORE_PATTERNS = [
  ".skillwiki/last-op.json",
  ".skillwiki/graph.json",
  ".skillwiki/sync.lock",
  ".skillwiki/managed-write.lock",
  ".skillwiki/memory/",
  ".skillwiki/memory-topics.json",
  ".skillwiki/work-complete/",
  ".skillwiki/vectors/",
] as const;

/** Paths to unstage from `git add -A` (gitignore patterns without trailing slash). */
export const VAULT_HYGIENE_GENERATED_COMMIT_PATHS = VAULT_HYGIENE_GITIGNORE_PATTERNS.map(
  (pattern) => pattern.replace(/\/$/, ""),
);

export const VAULT_SYNC_FILTER_REQUIRED_EXCLUDES = [
  "remotely-save/data.json",
  ".skillwiki/sync.lock",
  ".skillwiki/managed-write.lock",
  ".skillwiki/graph.json",
  ".skillwiki/memory/",
  ".skillwiki/memory-topics.json",
  ".skillwiki/work-complete/",
  ".skillwiki/last-op.json",
  ".claude/settings.local.json",
] as const;

export function missingIgnorePatterns(
  content: string,
  patterns: readonly string[],
): string[] {
  return patterns.filter((pattern) => !content.includes(pattern));
}

export function mergeGitignore(
  existing: string,
  required: readonly string[] = VAULT_HYGIENE_GITIGNORE_PATTERNS,
): { text: string; changed: boolean; added: string[] } {
  const added = missingIgnorePatterns(existing, required);
  if (added.length === 0) {
    return { text: existing, changed: false, added: [] };
  }
  const base = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  const block = [
    "# SkillWiki local scratch (not GitHub SSOT; keep session-brief and agent-memory-trends)",
    ...added,
    "",
  ].join("\n");
  return { text: `${base}${block}`, changed: true, added };
}

export function renderVaultGitignoreTemplate(): string {
  return [
    "# SkillWiki vault gitignore",
    "# Local scratch must not enter GitHub. Keep session-brief.* and agent-memory-trends/.",
    ...VAULT_HYGIENE_GITIGNORE_PATTERNS,
    ".obsidian/workspace.json",
    "*.conflict-*",
    ".conflict*",
    ".claude/settings.local.json",
    "._.DS_Store",
    ".DS_Store",
    "logs",
    "tmp/",
    "",
  ].join("\n");
}
