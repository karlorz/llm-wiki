import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { parseDotenvFile } from "../utils/dotenv.js";

// ── Types ─────────────────────────────────────────────────────

export interface CheckResult {
  id: string;
  label: string;
  status: "pass" | "warn" | "error";
  detail: string;
}

export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; warn: number; error: number };
}

export interface DoctorInput {
  home: string;
  envValue: string | undefined;
  envLang: string | undefined;
  argv: string[];
}

// ── Check helpers ─────────────────────────────────────────────

function pass(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: "pass", detail };
}

function warn(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: "warn", detail };
}

function error(id: string, label: string, detail: string): CheckResult {
  return { id, label, status: "error", detail };
}

// ── Individual checks ─────────────────────────────────────────

function checkNodeVersion(): CheckResult {
  const major = parseInt(process.version.slice(1).split(".")[0], 10);
  if (major >= 20) {
    return pass("node_version", "Node.js version", `v${major} >= 20`);
  }
  return error("node_version", "Node.js version", `Node.js v${major} is below minimum v20`);
}

function checkCliOnPath(argv: string[]): CheckResult {
  if (argv.length >= 2 && argv[1].endsWith("cli.js")) {
    return warn("cli_on_path", "skillwiki on PATH", "Running via node cli.js (dev mode) — PATH check skipped");
  }
  if (argv.length >= 2 && argv[1] === "skillwiki") {
    return pass("cli_on_path", "skillwiki on PATH", "Running as skillwiki — already on PATH");
  }
  try {
    execSync("which skillwiki 2>/dev/null", { encoding: "utf8" }).trim();
    return pass("cli_on_path", "skillwiki on PATH", "skillwiki found on PATH");
  } catch {
    return warn("cli_on_path", "skillwiki on PATH", "skillwiki not found on PATH");
  }
}

async function checkConfigFile(home: string): Promise<CheckResult> {
  const cfgPath = join(home, ".skillwiki", ".env");
  if (!existsSync(cfgPath)) {
    return warn("config_file", "Config file exists", `${cfgPath} not found`);
  }
  try {
    const map = await parseDotenvFile(cfgPath);
    const keys = Object.keys(map);
    return pass("config_file", "Config file exists", `Found with keys: ${keys.length > 0 ? keys.join(", ") : "(none set)"}`);
  } catch (e) {
    return warn("config_file", "Config file exists", `Failed to parse ${cfgPath}: ${String(e)}`);
  }
}

async function checkWikiPathSet(input: DoctorInput): Promise<CheckResult> {
  const r = await resolveRuntimePath({ flag: undefined, envValue: input.envValue, home: input.home });
  if (r.ok) {
    return pass("wiki_path_set", "WIKI_PATH configured", `Resolved via ${r.data.source}: ${r.data.path}`);
  }
  return error("wiki_path_set", "WIKI_PATH configured", "No vault configured. Run `skillwiki init` or pass --vault.");
}

function checkWikiPathExists(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return error("wiki_path_exists", "Vault directory exists", "Cannot check — WIKI_PATH not resolved");
  }
  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    return pass("wiki_path_exists", "Vault directory exists", resolvedPath);
  }
  return error("wiki_path_exists", "Vault directory exists", `${resolvedPath} does not exist or is not a directory`);
}

function checkVaultStructure(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return error("vault_structure", "Vault structure valid", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(resolvedPath)) {
    return error("vault_structure", "Vault structure valid", "Cannot check — vault directory does not exist");
  }
  const missing: string[] = [];
  if (!existsSync(join(resolvedPath, "SCHEMA.md"))) missing.push("SCHEMA.md");
  for (const dir of ["raw", "entities", "concepts", "meta"]) {
    if (!existsSync(join(resolvedPath, dir))) missing.push(dir + "/");
  }
  if (missing.length === 0) {
    return pass("vault_structure", "Vault structure valid", "All required files and directories present");
  }
  return error("vault_structure", "Vault structure valid", `Missing: ${missing.join(", ")}`);
}

function checkSkillsInstalled(home: string): CheckResult {
  const skillsDir = join(home, ".claude", "skills");
  if (!existsSync(skillsDir)) {
    return warn("skills_installed", "Skills installed", `${skillsDir} not found`);
  }
  const found = findSkillMd(skillsDir);
  if (found.length > 0) {
    return pass("skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found`);
  }
  return warn("skills_installed", "Skills installed", "No SKILL.md files found in ~/.claude/skills/");
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

// ── Main entry ────────────────────────────────────────────────

export async function runDoctor(
  input: DoctorInput
): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
  const checks: CheckResult[] = [];

  // 1. Node version
  checks.push(checkNodeVersion());

  // 2. CLI on PATH
  checks.push(checkCliOnPath(input.argv));

  // 3. Config file
  checks.push(await checkConfigFile(input.home));

  // 4. WIKI_PATH configured
  const wikiPathCheck = await checkWikiPathSet(input);
  checks.push(wikiPathCheck);

  // Resolve actual path for checks 5 & 6
  const resolved = await resolveRuntimePath({ flag: undefined, envValue: input.envValue, home: input.home });
  const resolvedPath = resolved.ok ? resolved.data.path : undefined;

  // 5. Vault directory exists
  checks.push(checkWikiPathExists(resolvedPath));

  // 6. Vault structure valid
  checks.push(checkVaultStructure(resolvedPath));

  // 7. Skills installed
  checks.push(checkSkillsInstalled(input.home));

  // Summary
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

  return { exitCode, result: ok({ checks, summary }) };
}
