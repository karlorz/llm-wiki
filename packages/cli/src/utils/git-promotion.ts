import { isEventLedgerPath } from "./vault-write-gates.js";

function normalizedRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** True when a live-vault path belongs to durable S3 data rather than host scratch. */
export function isS3OwnedPath(path: string): boolean {
  const rel = normalizedRelativePath(path);
  if (/^(?:\.git|\.playwright-cli|\.pytest_cache|\.snapshots|\.superpowers|\.antigravitycli|\.drafts|\.rclone-bisync|\.Trashes|\.fseventsd|\.Spotlight-V100|__pycache__|node_modules|logs)(?:\/|$)/.test(rel)) {
    return false;
  }
  if (/^(?:\.DS_Store|\.mypy_cache)(?:\/|$)/.test(rel) || rel.startsWith("._") || rel.endsWith(".pyc")) return false;
  if (rel.startsWith(".conflict") || rel.includes(".conflict-")) return false;
  if (rel === ".obsidian/plugins/remotely-save/data.json" || rel === ".obsidian/workspace.json") return false;
  if (/^\.obsidian\/plugins\/[^/]+\/main\.js$/.test(rel)) return false;
  if (rel === ".claude/settings.local.json" || rel.startsWith(".claude/dev-loop/")) return false;
  if (/^\.skillwiki\/(?:sync\.lock|managed-write\.lock|graph\.json|memory(?:\/|$)|memory-topics\.json|work-complete(?:\/|$)|last-op\.json|vectors(?:\/|$))/.test(rel)) {
    return false;
  }
  return true;
}

/** GitHub promotion policy for snapshot/projection content. */
export function isGitPromotablePath(path: string): boolean {
  const rel = normalizedRelativePath(path);
  if (/^(?:\.skillwiki|\.claude|\.obsidian|\.antigravitycli|\.playwright-cli|\.superpowers|\.snapshots|\.git|\.drafts)(?:\/|$)/.test(rel)) {
    return false;
  }
  if (/^(?:tmp|logs)(?:\/|$)/.test(rel) || isEventLedgerPath(rel)) return false;
  if (rel === "raw/._.DS_Store" || rel === "._.DS_Store" || rel.startsWith("._")) return false;
  if (rel.startsWith(".conflict") || rel.includes(".conflict-")) return false;
  return true;
}

/** Paths allowed to materialize and appear in the independent Git projection. */
export function isGitPresentationPath(path: string): boolean {
  return isGitPromotablePath(path);
}

/** Existing VaultScan inventory boundary; Git ignore filtering is a separate step. */
export function isMarkdownInventoryPath(path: string): boolean {
  return normalizedRelativePath(path).endsWith(".md");
}
