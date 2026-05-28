import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";

const MAX_PATH_LENGTH = 240;

export interface PathTooLongInput { vault: string }
export interface PathTooLongOutput {
  violations: Array<{ relPath: string; length: number }>;
  humanHint: string;
}

export async function runPathTooLong(input: PathTooLongInput): Promise<{ exitCode: number; result: Result<PathTooLongOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const allPages = [...scan.data.typedKnowledge, ...scan.data.raw, ...scan.data.workItems, ...scan.data.compound];
  const violations: PathTooLongOutput["violations"] = [];

  for (const page of allPages) {
    if (page.relPath.length > MAX_PATH_LENGTH) {
      violations.push({ relPath: page.relPath, length: page.relPath.length });
    }
  }

  if (violations.length > 0) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: ok({
        violations,
        humanHint: violations.map(v => `${v.relPath}: ${v.length} chars (max ${MAX_PATH_LENGTH})`).join("\n")
      })
    };
  }

  return { exitCode: ExitCode.OK, result: ok({ violations, humanHint: "all paths within length limit" }) };
}

/**
 * Compute a truncated filename that fits within MAX_PATH_LENGTH.
 * Preserves directory structure, truncates only the filename component.
 * Strategy: prefix (up to ~224 chars) + "-" + 8-char hex hash + ".md"
 */
export function truncateFilename(relPath: string, maxLength: number = MAX_PATH_LENGTH): string {
  if (relPath.length <= maxLength) return relPath;

  const lastSlash = relPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : "";
  const filename = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;

  // Hash of the full original path for uniqueness
  const hash = computeShortHash(relPath);

  // .md extension preserved
  const ext = filename.endsWith(".md") ? ".md" : "";
  const base = filename.endsWith(".md") ? filename.slice(0, -3) : filename;

  // Available budget for the filename prefix
  const suffix = `-${hash}${ext}`;
  const dirPrefix = dir ? dir + "/" : "";
  const maxPrefixLen = maxLength - dirPrefix.length - suffix.length;

  if (maxPrefixLen <= 0) {
    // Directory path alone is too long — fall back to hash-only filename
    const fallback = dirPrefix + hash + ext;
    if (fallback.length > maxLength) {
      // Even that's too long — truncate the directory
      const dirBudget = maxLength - suffix.length;
      return dirPrefix.slice(0, Math.max(0, dirBudget)) + suffix;
    }
    return fallback;
  }

  const prefix = base.slice(0, maxPrefixLen).replace(/[-_\s]+$/, "");
  return dirPrefix + prefix + suffix;
}

function computeShortHash(input: string): string {
  // Simple FNV-1a 32-bit hash, hex-encoded
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
