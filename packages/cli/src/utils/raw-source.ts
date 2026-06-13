import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

export function normalizeRawSourceTarget(entry: string): string | null {
  let target = entry.trim().replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "");
  target = target.replace(/^\^\[/, "").replace(/\]$/, "");
  if (!target.startsWith("raw/") && !target.startsWith("_archive/raw/")) return null;
  return target;
}

export function rawSourceTargetCandidates(vault: string, target: string): string[] {
  const normalized = normalizeRawSourceTarget(target);
  if (!normalized) return [];

  const candidates = [join(vault, normalized)];
  if (!normalized.endsWith(".md")) candidates.push(join(vault, `${normalized}.md`));

  if (normalized.startsWith("raw/")) {
    candidates.push(join(vault, "_archive", normalized));
    if (!normalized.endsWith(".md")) candidates.push(join(vault, "_archive", `${normalized}.md`));
  }

  return [...new Set(candidates)];
}

export function rawSourceTargetExistsSync(vault: string, target: string): boolean {
  return rawSourceTargetCandidates(vault, target).some(candidate => existsSync(candidate));
}

export async function rawSourceTargetExists(vault: string, target: string): Promise<boolean> {
  for (const candidate of rawSourceTargetCandidates(vault, target)) {
    try {
      await stat(candidate);
      return true;
    } catch {
      // Continue through active/archive and extension fallback candidates.
    }
  }
  return false;
}
