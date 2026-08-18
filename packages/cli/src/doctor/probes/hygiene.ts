import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanVaultConflictMarkers } from "../../utils/conflict-markers.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function checkDotStoreClean(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "dsstore_clean", "No .DS_Store in raw/", "Cannot check — WIKI_PATH not resolved");
  }
  const rawDir = join(resolvedPath, "raw");
  if (!existsSync(rawDir)) {
    return check("pass", "dsstore_clean", "No .DS_Store in raw/", "raw/ directory not found — check skipped");
  }
  const found: string[] = [];
  (function walk(dir: string, rel: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        found.push(rel ? `${rel}/.DS_Store` : ".DS_Store");
      } else if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  })(rawDir, "");
  if (found.length === 0) {
    return check("pass", "dsstore_clean", "No .DS_Store in raw/", "No .DS_Store files found");
  }
  return check("info", "dsstore_clean", "No .DS_Store in raw/", `${found.length} .DS_Store file(s) found — remove with: find ${rawDir} -name .DS_Store -delete`);
}

function checkVaultConflictMarkers(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_conflict_markers", "Vault conflict markers", "No vault path — check skipped");
  }
  const findings = scanVaultConflictMarkers(resolvedPath);
  if (findings.length === 0) {
    return check("pass", "vault_conflict_markers", "Vault conflict markers", "No complete conflict-marker blocks");
  }
  const first = findings[0];
  const n = findings.length;
  const fileWord = n === 1 ? "file" : "files";
  return check(
    "error",
    "vault_conflict_markers",
    "Vault conflict markers",
    `${n} ${fileWord}, first: ${first.path}:${first.line}`,
  );
}

export const hygieneProbe: DoctorProbe = {
  id: "hygiene",
  run(ctx: DoctorContext): CheckResult[] {
    return [
      checkDotStoreClean(ctx.readOnlyScanRoot),
      checkVaultConflictMarkers(ctx.readOnlyScanRoot),
    ];
  },
};
