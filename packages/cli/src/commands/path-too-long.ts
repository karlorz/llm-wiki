import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { safeWritePage } from "../utils/safe-write.js";
import { scanVault, type VaultPage } from "../utils/vault.js";

export const MAX_PATH_LENGTH = 240;
const WINDOWS_ABSOLUTE_PATH_LIMIT = 259;

export interface PathTooLongInput { vault: string }
export interface PathTooLongViolation {
  relPath: string;
  length: number;
  suggestedRelPath: string;
}
export interface PathTooLongOutput {
  violations: PathTooLongViolation[];
  humanHint: string;
}

export interface PathTooLongFix {
  from: string;
  to: string;
}

export interface PathTooLongFixOutput {
  fixed: PathTooLongFix[];
  unresolved: string[];
  rewired: string[];
  humanHint: string;
}

export async function runPathTooLong(input: PathTooLongInput): Promise<{ exitCode: number; result: Result<PathTooLongOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const violations = findPathTooLongViolations(scan.data.allMarkdown, MAX_PATH_LENGTH);

  if (violations.length > 0) {
    return {
      exitCode: ExitCode.LINT_HAS_ERRORS,
      result: ok({
        violations,
        humanHint: violations.map(v => `${v.relPath}: ${v.length} chars (max ${MAX_PATH_LENGTH}) -> ${v.suggestedRelPath}`).join("\n")
      })
    };
  }

  return { exitCode: ExitCode.OK, result: ok({ violations, humanHint: "all paths within length limit" }) };
}

export async function fixPathTooLong(input: PathTooLongInput): Promise<{ exitCode: number; result: Result<PathTooLongFixOutput> }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const maxFixLength = maxFixPathLength(input.vault);
  const violations = findPathTooLongViolations(scan.data.allMarkdown, maxFixLength);
  const fixed: PathTooLongFix[] = [];
  const unresolved: string[] = [];

  for (const violation of violations) {
    const target = await resolveFixTarget(input.vault, violation.relPath, violation.suggestedRelPath, maxFixLength);
    if (!target || target.relPath === violation.relPath || target.relPath.length > maxFixLength) {
      unresolved.push(violation.relPath);
      continue;
    }

    try {
      if (target.mode === "dedupe") {
        await unlink(join(input.vault, violation.relPath));
      } else {
        await mkdir(dirname(join(input.vault, target.relPath)), { recursive: true });
        await rename(join(input.vault, violation.relPath), join(input.vault, target.relPath));
      }
      fixed.push({ from: violation.relPath, to: target.relPath });
    } catch {
      unresolved.push(violation.relPath);
    }
  }

  const rewired: string[] = [];
  if (fixed.length > 0) {
    const afterScan = await scanVault(input.vault);
    if (afterScan.ok) {
      for (const page of afterScan.data.allMarkdown) {
        if (!shouldRewriteReferences(page.relPath)) continue;
        try {
          const original = await readFile(page.absPath, "utf8");
          let updated = original;
          for (const fix of fixed) {
            updated = replacePathReferences(updated, fix.from, fix.to);
          }
          if (updated !== original) {
            const write = await safeWritePage(page.absPath, updated);
            if (write.ok) rewired.push(page.relPath);
            else unresolved.push(`${page.relPath} (rewire)`);
          }
        } catch {
          unresolved.push(`${page.relPath} (rewire)`);
        }
      }
    }
  }

  const hintLines = [
    `fixed: ${fixed.length}`,
    `rewired: ${rewired.length}`,
    `unresolved: ${unresolved.length}`,
  ];
  for (const f of fixed) hintLines.push(`  ${f.from} -> ${f.to}`);
  for (const u of unresolved) hintLines.push(`  unresolved: ${u}`);

  return {
    exitCode: unresolved.length > 0 ? ExitCode.LINT_HAS_ERRORS : ExitCode.OK,
    result: ok({ fixed, unresolved, rewired, humanHint: hintLines.join("\n") }),
  };
}

function findPathTooLongViolations(pages: VaultPage[], maxLength: number): PathTooLongViolation[] {
  return pages
    .filter(page => page.relPath.length > maxLength)
    .map(page => ({
      relPath: page.relPath,
      length: page.relPath.length,
      suggestedRelPath: truncateFilename(page.relPath, maxLength),
    }));
}

function maxFixPathLength(vault: string): number {
  if (process.platform !== "win32") return MAX_PATH_LENGTH;

  // Git for Windows can still reject a path whose relative length is within
  // MAX_PATH_LENGTH when the vault root makes the absolute path exceed MAX_PATH.
  const root = resolve(vault);
  const separatorBudget = root.endsWith("\\") || root.endsWith("/") ? 0 : 1;
  const absoluteSafeRelLength = WINDOWS_ABSOLUTE_PATH_LIMIT - root.length - separatorBudget;
  return Math.max(1, Math.min(MAX_PATH_LENGTH, absoluteSafeRelLength));
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
    return fallback.length <= maxLength ? fallback : relPath;
  }

  const prefix = base.slice(0, maxPrefixLen).replace(/[-_\s]+$/, "");
  return dirPrefix + prefix + suffix;
}

interface FixTarget {
  relPath: string;
  mode: "rename" | "dedupe";
}

async function resolveFixTarget(vault: string, original: string, preferred: string, maxLength: number): Promise<FixTarget | null> {
  for (const candidate of candidateRelPaths(preferred, maxLength)) {
    if (candidate === original || candidate.length > maxLength) continue;
    const candidatePath = join(vault, candidate);
    if (!existsSync(candidatePath)) return { relPath: candidate, mode: "rename" };
    if (await hasSameContent(join(vault, original), candidatePath)) {
      return { relPath: candidate, mode: "dedupe" };
    }
  }
  return null;
}

function candidateRelPaths(preferred: string, maxLength: number): string[] {
  const candidates = [preferred];
  if (preferred.length > maxLength) return candidates;

  const dir = posix.dirname(preferred) === "." ? "" : posix.dirname(preferred);
  const filename = posix.basename(preferred);
  const ext = filename.endsWith(".md") ? ".md" : "";
  const base = ext ? filename.slice(0, -3) : filename;
  const dirPrefix = dir ? `${dir}/` : "";

  for (let i = 2; i < 100; i++) {
    const suffix = `-${i}${ext}`;
    const prefixBudget = maxLength - dirPrefix.length - suffix.length;
    if (prefixBudget <= 0) break;
    candidates.push(`${dirPrefix}${base.slice(0, prefixBudget).replace(/[-_\s]+$/, "")}${suffix}`);
  }

  return candidates;
}

async function hasSameContent(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

function shouldRewriteReferences(relPath: string): boolean {
  // Raw source bodies are immutable after ingest; path fixing may rename them,
  // but it must not rewrite captured source content.
  if (relPath.startsWith("raw/")) return false;
  if (relPath.startsWith("_archive/")) return false;
  return true;
}

function replacePathReferences(content: string, oldRelPath: string, newRelPath: string): string {
  let updated = content.replaceAll(oldRelPath, newRelPath);

  const oldStem = posix.basename(oldRelPath).replace(/\.md$/, "");
  const newStem = posix.basename(newRelPath).replace(/\.md$/, "");
  if (oldStem !== newStem) {
    const oldStemEscaped = oldStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stemWikilinkRe = new RegExp(`\\[\\[${oldStemEscaped}(\\|[^\\]]*)?\\]\\]`, "g");
    updated = updated.replace(stemWikilinkRe, (_match, alias) => `[[${newStem}${alias ?? ""}]]`);
  }

  return updated;
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
