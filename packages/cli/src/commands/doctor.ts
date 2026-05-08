import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { configPath } from "./config.js";
import { latestFromCache } from "../utils/auto-update.js";
import { semverGt } from "../utils/semver.js";
import { findPlugin } from "../utils/plugin-registry.js";

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
  cwd?: string;
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
  return check("warn", "vault_structure", "Vault structure valid", `Missing: ${missing.join(", ")} — run \`skillwiki init\` to add CodeWiki structure`);
}

function checkSkillsInstalled(home: string, cwd?: string): CheckResult {
  // Check CWD source tree first (for dev/project runs)
  const srcDir = cwd ? join(cwd, "packages", "skills") : undefined;
  if (srcDir && existsSync(srcDir)) {
    const found = findSkillMd(srcDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (source)`);
    }
  }
  const plugin = findPlugin(home);
  if (plugin) {
    const found = findSkillMd(plugin.installPath);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (plugin v${plugin.version})`);
    }
  }
  const skillsDir = join(home, ".claude", "skills");
  if (existsSync(skillsDir)) {
    const found = findSkillMd(skillsDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (CLI install)`);
    }
  }
  return check("warn", "skills_installed", "Skills installed", "No SKILL.md files found");
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

function checkPluginVersionDrift(home: string, currentVersion: string): CheckResult {
  const plugin = findPlugin(home);
  if (!plugin) {
    return check("pass", "plugin_version_drift", "Plugin/CLI version", "Plugin not installed — CLI only");
  }
  const pluginVersion = plugin.version;
  if (pluginVersion === currentVersion) {
    return check("pass", "plugin_version_drift", "Plugin/CLI version", `Both at v${currentVersion}`);
  }
  // Versions differ — warn
  const updateCmd = semverGt(pluginVersion, currentVersion)
    ? "npm install -g skillwiki@beta"
    : "claude plugin update skillwiki@llm-wiki";
  return check(
    "warn",
    "plugin_version_drift",
    "Plugin/CLI version",
    `Plugin v${pluginVersion} ≠ CLI v${currentVersion} — run \`${updateCmd}\``
  );
}

async function checkProfiles(home: string): Promise<CheckResult> {
  const map = await parseDotenvFile(configPath(home));
  const profiles: string[] = [];
  for (const key of Object.keys(map)) {
    if (key.startsWith("WIKI_") && key.endsWith("_PATH") && key !== "WIKI_PATH") {
      const name = key.slice(5, -5).toLowerCase().replace(/_/g, "-");
      profiles.push(name);
    }
  }
  if (profiles.length === 0) {
    return check("pass", "wiki_profiles", "Wiki profiles", "No named profiles configured");
  }
  const defaultProfile = map["WIKI_DEFAULT"] ?? "(none)";
  return check("pass", "wiki_profiles", "Wiki profiles",
    `${profiles.length} profile(s): ${profiles.join(", ")}; default: ${defaultProfile}`);
}

async function checkProjectLocalOverride(cwd?: string): Promise<CheckResult> {
  const dir = cwd ?? process.cwd();
  const envPath = join(dir, ".skillwiki", ".env");
  if (existsSync(envPath)) {
    return check("pass", "project_local", "Project-local config", `Found: ${envPath}`);
  }
  return check("pass", "project_local", "Project-local config", "None");
}

function checkVaultGitRemote(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "vault_git_remote", "Vault git remote", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("warn", "vault_git_remote", "Vault git remote", "Vault is not a git repository — sync features unavailable");
  }
  try {
    const remote = execSync("git remote", { cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!remote) {
      return check("warn", "vault_git_remote", "Vault git remote", "No remote configured — push/pull unavailable");
    }
    let branch = "(no commits yet)";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch { /* empty repo — no HEAD yet */ }
    return check("pass", "vault_git_remote", "Vault git remote", `Remote: ${remote.split("\n")[0]}, branch: ${branch}`);
  } catch {
    return check("warn", "vault_git_remote", "Vault git remote", "Could not read git remote info");
  }
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
  return check("warn", "dsstore_clean", "No .DS_Store in raw/", `${found.length} .DS_Store file(s) found — remove with: find ${rawDir} -name .DS_Store -delete`);
}

function checkSyncLastPush(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "sync_last_push", "Vault sync recency", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "sync_last_push", "Vault sync recency", "No git repo — sync check skipped");
  }
  let timestamp: number | undefined;
  // Try origin/HEAD first (last pushed commit)
  try {
    const out = execSync("git log -1 --format=%ct origin/HEAD", {
      cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    timestamp = parseInt(out, 10);
  } catch {
    // Fallback to last local commit
    try {
      const out = execSync("git log -1 --format=%ct HEAD", {
        cwd: resolvedPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      timestamp = parseInt(out, 10);
    } catch {
      // No commits at all
    }
  }
  if (timestamp === undefined || isNaN(timestamp)) {
    return check("warn", "sync_last_push", "Vault sync recency", "No commits found — consider running `skillwiki sync status`");
  }
  const daysSince = Math.floor((Date.now() / 1000 - timestamp) / 86400);
  const dateStr = new Date(timestamp * 1000).toISOString().slice(0, 10);
  if (daysSince > 7) {
    return check("warn", "sync_last_push", "Vault sync recency", `Last push was ${daysSince} days ago — consider running \`skillwiki sync status\``);
  }
  return check("pass", "sync_last_push", "Vault sync recency", `Last push: ${dateStr} (${daysSince} day(s) ago)`);
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
  checks.push(await checkProfiles(input.home));
  checks.push(await checkProjectLocalOverride(input.cwd));

  const resolved = await resolveRuntimePath({ flag: undefined, envValue: input.envValue, home: input.home });
  if (resolved.ok) {
    checks.push(check("pass", "wiki_path_set", "WIKI_PATH configured", `Resolved via ${resolved.data.source}: ${resolved.data.path}`));
  } else {
    checks.push(check("error", "wiki_path_set", "WIKI_PATH configured", "No vault configured. Run `skillwiki init` or pass --vault."));
  }
  const resolvedPath = resolved.ok ? resolved.data.path : undefined;

  checks.push(checkWikiPathExists(resolvedPath));
  checks.push(checkVaultStructure(resolvedPath));
  checks.push(checkObsidianTemplates(resolvedPath));
  checks.push(checkVaultGitRemote(resolvedPath));
  checks.push(checkSyncLastPush(resolvedPath));
  checks.push(checkDotStoreClean(resolvedPath));
  checks.push(checkSkillsInstalled(input.home, input.cwd));
  checks.push(checkNpmUpdate(input.home, input.currentVersion));
  checks.push(checkPluginVersionDrift(input.home, input.currentVersion));

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
