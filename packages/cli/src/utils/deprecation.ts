import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the installed skill manifest and return deprecation warning strings
 * for any skill marked `deprecated: true`. Returns an empty array when
 * the manifest is absent or contains no deprecated skills.
 */
export function getDeprecatedWarnings(home: string): string[] {
  const manifestPath = join(home, ".claude", "skills", "wiki-manifest.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);
    if (!manifest.skills) return [];
    const warnings: string[] = [];
    for (const [dirName, meta] of Object.entries(manifest.skills as Record<string, { name?: string; deprecated?: boolean }>)) {
      if (meta.deprecated) {
        warnings.push(`⚠ Skill "${meta.name || dirName}" is deprecated. See SKILL.md for migration notes.`);
      }
    }
    return warnings;
  } catch {
    return [];
  }
}
