import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

const VAULT_TRACKED_DIRS = ["raw", "entities", "concepts", "comparisons", "queries", "meta", "_archive", "_Templates"];

/**
 * Audit .DS_Store files across all vault tracked directories.
 * Returns advisory warning (G11) with count and sample paths when found.
 */
export function checkDsStoreNoise(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "ds_store_noise", "No .DS_Store noise", "No vault path — check skipped");
  }
  if (!existsSync(resolvedPath)) {
    return check("pass", "ds_store_noise", "No .DS_Store noise", "Vault directory does not exist — check skipped");
  }

  const found: string[] = [];

  function walk(dir: string, rel: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        found.push(rel ? `${rel}/.DS_Store` : ".DS_Store");
      } else if (entry.isDirectory()) {
        // Skip .git and node_modules
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }

  // Walk root and standard tracked directories if present
  let scannedAny = false;
  for (const sub of VAULT_TRACKED_DIRS) {
    const subDir = join(resolvedPath, sub);
    if (existsSync(subDir)) {
      scannedAny = true;
      walk(subDir, sub);
    }
  }

  // If no standard tracked subdirectories exist, scan root directly
  if (!scannedAny) {
    walk(resolvedPath, "");
  }

  if (found.length === 0) {
    return check("pass", "ds_store_noise", "No .DS_Store noise", "No .DS_Store files found in vault");
  }

  const examples = found.slice(0, 3).join(", ");
  const more = found.length > 3 ? ", …" : "";
  return check(
    "warn",
    "ds_store_noise",
    "No .DS_Store noise",
    `${found.length} .DS_Store file(s) found (${examples}${more}) — remove with: find ${resolvedPath} -name .DS_Store -delete`
  );
}

export const dsStoreNoiseProbe: DoctorProbe = {
  id: "ds_store_noise",
  run(ctx: DoctorContext): CheckResult[] {
    return [checkDsStoreNoise(ctx.readOnlyScanRoot ?? ctx.resolvedPath)];
  },
};
