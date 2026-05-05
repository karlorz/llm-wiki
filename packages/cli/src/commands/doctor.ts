import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { configPath } from "./config.js";
import { latestFromCache } from "../utils/auto-update.js";

export type CheckStatus = "pass" | "warn" | "error";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; warn: number; error: number };
  humanHint: string;
}

export interface DoctorInput {
  home: string;
  envValue: string | undefined;
  argv: string[];
  currentVersion: string;
}

function check(status: CheckStatus, id: string, label: string, detail: string): CheckResult {
  return { id, label, status, detail };
}

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  if (major >= 20) {
    return check("pass", "node_version", "Node.js version", `v${major} >= 20`);
  }
  return check("error", "node_version", "Node.js version", `Node.js v${major} is below minimum v20`);
}

function checkCliOnPath(argv: string[]): CheckResult {
  if (argv.length >= 2 && argv[1].endsWith("cli.js")) {
    return check("warn", "cli_on_path", "skillwiki on PATH", "Running via node cli.js (dev mode) — PATH check skipped");
  }
  if (argv.length >= 2 && argv[1] === "skillwiki") {
    return check("pass", "cli_on_path", "skillwiki on PATH", "Running as skillwiki — already on PATH");
  }
  try {
    execSync("which skillwiki 2>/dev/null", { encoding: "utf8" }).trim();
    return check("pass", "cli_on_path", "skillwiki on PATH", "skillwiki found on PATH");
  } catch {
    return check("warn", "cli_on_path", "skillwiki on PATH", "skillwiki not found on PATH");
  }
}

async function checkConfigFile(home: string): Promise<CheckResult> {
  const cfgPath = configPath(home);
  if (!existsSync(cfgPath)) {
    return check("warn", "config_file", "Config file exists", `${cfgPath} not found`);
  }
  try {
    const map = await parseDotenvFile(cfgPath);
    const keys = Object.keys(map);
    return check("pass", "config_file", "Config file exists", `Found with keys: ${keys.length > 0 ? keys.join(", ") : "(none set)"}`);
  } catch (e) {
    return check("warn", "config_file", "Config file exists", `Failed to parse ${cfgPath}: ${String(e)}`);
  }
}

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
  return check("error", "vault_structure", "Vault structure valid", `Missing: ${missing.join(", ")}`);
}

function checkSkillsInstalled(home: string): CheckResult {
  const skillsDir = join(home, ".claude", "skills");
  if (!existsSync(skillsDir)) {
    return check("warn", "skills_installed", "Skills installed", `${skillsDir} not found`);
  }
  const found = findSkillMd(skillsDir);
  if (found.length > 0) {
    return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found`);
  }
  return check("warn", "skills_installed", "Skills installed", "No SKILL.md files found in ~/.claude/skills/");
}

function checkNpmUpdate(home: string, currentVersion: string): CheckResult {
  const { hasUpdate, latest } = latestFromCache(home, currentVersion);
  if (!latest) {
    return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (no cache yet)`);
  }
  if (hasUpdate) {
    return check("warn", "npm_update", "npm CLI version", `v${currentVersion} — update available: v${latest}. Run \`skillwiki update\`.`);
  }
  return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (latest: v${latest})`);
}

function findSkillMd(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(join(dir, entry.name));
    } else if (entry.isDirectory()) {
      results.push(...findSkillMd(join(dir, entry.name)));
    }
  }
  return results;
}

export async function runDoctor(
  input: DoctorInput
): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
  const checks: CheckResult[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkCliOnPath(input.argv));
  checks.push(await checkConfigFile(input.home));

  const resolved = await resolveRuntimePath({ flag: undefined, envValue: input.envValue, home: input.home });
  if (resolved.ok) {
    checks.push(check("pass", "wiki_path_set", "WIKI_PATH configured", `Resolved via ${resolved.data.source}: ${resolved.data.path}`));
  } else {
    checks.push(check("error", "wiki_path_set", "WIKI_PATH configured", "No vault configured. Run `skillwiki init` or pass --vault."));
  }
  const resolvedPath = resolved.ok ? resolved.data.path : undefined;

  checks.push(checkWikiPathExists(resolvedPath));
  checks.push(checkVaultStructure(resolvedPath));
  checks.push(checkSkillsInstalled(input.home));
  checks.push(checkNpmUpdate(input.home, input.currentVersion));

  const summary = {
    pass: checks.filter(c => c.status === "pass").length,
    warn: checks.filter(c => c.status === "warn").length,
    error: checks.filter(c => c.status === "error").length,
  };

  const exitCode = summary.error > 0
    ? ExitCode.DOCTOR_HAS_ERRORS
    : summary.warn > 0
      ? ExitCode.DOCTOR_HAS_WARNINGS
      : ExitCode.OK;

  const statusIcon: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", error: "✗" };
  const lines = checks.map(c => {
    const icon = statusIcon[c.status];
    const padded = c.label.padEnd(24);
    return `  ${icon} ${padded} ${c.detail}`;
  });
  lines.push("");
  lines.push(`${summary.pass} pass · ${summary.warn} warn · ${summary.error} error`);
  const humanHint = lines.join("\n");

  return { exitCode, result: ok({ checks, summary, humanHint }) };
}
