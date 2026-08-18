import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

function checkWikiPathExists(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "wiki_path_exists", "Vault directory exists", "Cannot check — WIKI_PATH not resolved");
  }
  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    return check("pass", "wiki_path_exists", "Vault directory exists", resolvedPath);
  }
  return check("error", "wiki_path_exists", "Vault directory exists", `${resolvedPath} does not exist or is not a directory`);
}

function checkVaultStructure(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "vault_structure", "Vault structure valid", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(resolvedPath)) {
    return check("error", "vault_structure", "Vault structure valid", "Cannot check — vault directory does not exist");
  }
  const missing: string[] = [];
  if (!existsSync(join(resolvedPath, "SCHEMA.md"))) missing.push("SCHEMA.md");
  for (const dir of ["raw", "entities", "concepts", "meta"]) {
    if (!existsSync(join(resolvedPath, dir))) missing.push(dir + "/");
  }
  if (missing.length === 0) {
    return check("pass", "vault_structure", "Vault structure valid", "All required files and directories present");
  }
  return check("warn", "vault_structure", "Vault structure valid", `Missing: ${missing.join(", ")} — run \`skillwiki init\` to add CodeWiki structure`);
}

function checkObsidianTemplates(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "obsidian_templates", "Obsidian templates", "Cannot check — WIKI_PATH not resolved");
  }
  const missing: string[] = [];
  if (!existsSync(join(resolvedPath, "_Templates"))) missing.push("_Templates/");
  if (!existsSync(join(resolvedPath, ".obsidian", "templates.json"))) missing.push(".obsidian/templates.json");
  if (!existsSync(join(resolvedPath, ".obsidian", "app.json"))) missing.push(".obsidian/app.json");
  if (missing.length === 0) {
    return check("pass", "obsidian_templates", "Obsidian templates", "Template folder and config present");
  }
  return check("warn", "obsidian_templates", "Obsidian templates", `Missing: ${missing.join(", ")} — run \`skillwiki init\` to create`);
}

export const vaultStructureProbe: DoctorProbe = {
  id: "vault_structure",
  run(ctx: DoctorContext): CheckResult[] {
    return [
      checkWikiPathExists(ctx.resolvedPath),
      checkVaultStructure(ctx.resolvedPath),
      checkObsidianTemplates(ctx.resolvedPath),
    ];
  },
};
