import { join, posix, relative } from "node:path";
import { buildSourceRelocationProjection, readSourceRelocations, resolveRelocatedSource } from "./source-relocations.js";
import { existingRegularFileInsideVaultSync, resolveExistingRegularFileInsideVault } from "./vault-path-safety.js";

export function normalizeRawSourceTarget(entry: string): string | null {
  let target = entry.trim().replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, "");
  target = target.replace(/^\^\[/, "").replace(/\]$/, "");
  if (!target || target.includes("\0") || target.includes("\\") || posix.isAbsolute(target)) return null;
  if (posix.normalize(target) !== target || target.split("/").some(part => part === "" || part === "." || part === "..")) return null;
  if (!target.startsWith("raw/") && !target.startsWith("_archive/raw/")) return null;
  return target;
}

export function rawSourceTargetCandidates(vault: string, target: string): string[] {
  const normalized = normalizeRawSourceTarget(target);
  if (!normalized) return [];

  const candidates = [join(vault, normalized)];
  if (!normalized.endsWith(".md")) candidates.push(join(vault, `${normalized}.md`));

  if (normalized.startsWith("raw/")) {
    const active = normalized.match(/^raw\/(articles|papers|transcripts)\/(.+)$/);
    if (active) {
      for (const lifecycle of ["archived", "duplicates"] as const) {
        candidates.push(join(vault, "raw", lifecycle, active[1]!, active[2]!));
        if (!normalized.endsWith(".md")) candidates.push(join(vault, "raw", lifecycle, active[1]!, `${active[2]!}.md`));
      }
      candidates.push(join(vault, "_archive", normalized));
      if (!normalized.endsWith(".md")) candidates.push(join(vault, "_archive", `${normalized}.md`));
    }
  }

  return [...new Set(candidates)];
}

export function rawSourceTargetExistsSync(vault: string, target: string): boolean {
  return rawSourceTargetCandidates(vault, target).some(candidate =>
    existingRegularFileInsideVaultSync(vault, relative(vault, candidate)),
  );
}

export async function rawSourceTargetExists(vault: string, target: string): Promise<boolean> {
  for (const candidate of rawSourceTargetCandidates(vault, target)) {
    if ((await resolveExistingRegularFileInsideVault(vault, relative(vault, candidate))).ok) return true;
  }
  const relocations = await readSourceRelocations(vault);
  if (relocations.ok) {
    const normalized = normalizeRawSourceTarget(target);
    if (normalized) {
      const resolved = resolveRelocatedSource(normalized.endsWith(".md") ? normalized : `${normalized}.md`, buildSourceRelocationProjection(relocations.data));
      if (resolved !== normalized) {
        if ((await resolveExistingRegularFileInsideVault(vault, resolved)).ok) return true;
      }
    }
  }
  return false;
}
