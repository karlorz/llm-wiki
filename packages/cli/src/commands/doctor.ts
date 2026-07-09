import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { existsSync, lstatSync, readlinkSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { configPath } from "./config.js";
import { latestFromCache } from "../utils/auto-update.js";
import { semverGt } from "../utils/semver.js";
import { findPlugin, findPluginInstallations, type PluginChannelInstall } from "../utils/plugin-registry.js";
import { scanVault } from "../utils/vault.js";
import { scanVaultConflictMarkers } from "../utils/conflict-markers.js";
import { buildWikilinkAdjacency, toUndirectedWeighted, louvain, communityCohesion } from "../utils/community.js";
import {
  probeGithubReachability,
  probeS3Reachability,
  probeSnapshotterSsh,
  readWikiS3RemoteFromEnv,
  type ExecProbe,
} from "../utils/remote-health.js";
import { loadFleetManifestAndHost, satelliteGateFromFleetLoad, type FleetManifestAndHost } from "./fleet.js";
import {
  evaluateSatelliteRunHealth,
  satelliteLatestRunPath,
} from "../utils/satellite-run-health.js";
import {
  findRcloneMountPid,
  parseRcloneFlags,
  getRcloneArgs,
  extractRcloneFs,
  getRcloneVersion,
  queryRcloneRC,
  detectFuseMount,
  writeTest,
  parseDurationSeconds,
  FLAG_THRESHOLDS,
  MIN_RCLONE_VERSION,
} from "../utils/s3-mount-health.js";

export type CheckStatus = "pass" | "info" | "warn" | "error";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; info: number; warn: number; error: number };
  humanHint: string;
}

export interface DoctorInput {
  home: string;
  envValue: string | undefined;
  argv: string[];
  currentVersion: string;
  cwd?: string;
  /** When true, SSH-probe fleet snapshotter (short timeout). Default false. */
  checkSnapshotter?: boolean;
  /** Injectable exec for reachability probes (tests). */
  execProbe?: ExecProbe;
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

interface CliChannel {
  name: string;
  path: string;
  /** True if this is a symlink back into the dev source repo. */
  isDevLink: boolean;
}

/**
 * Detect all skillwiki CLI channels on this machine.
 *
 * Channels (in detection order):
 *   1. dev source — argv[1] ends with cli.js (running `node packages/cli/dist/cli.js`)
 *   2. npm global — /usr/local/bin/skillwiki or /opt/homebrew/bin/skillwiki
 *   3. plugin bin  — ~/.claude/plugins/cache/{marketplace}/skillwiki/{ver}/bin/skillwiki
 *   4. CLI install — ~/.claude/skills/bin/skillwiki (from `npx skillwiki install`)
 */
function detectCliChannels(argv: string[], home: string): CliChannel[] {
  const channels: CliChannel[] = [];

  // 1. Dev source — detected from how the CLI was invoked
  if (argv.length >= 2 && argv[1].endsWith("cli.js")) {
    const devPath = resolve(argv[1]);
    channels.push({ name: "dev", path: devPath, isDevLink: true });
  }

  // 2. npm global — check if skillwiki is on PATH and resolve
  try {
    const whichOut = execSync("which skillwiki 2>/dev/null", { encoding: "utf8" }).trim();
    if (whichOut) {
      const isDev = isDevSymlink(whichOut);
      // Skip if it's the same path as the dev channel (npm link → dev source)
      if (!channels.some(c => c.path === resolve(whichOut))) {
        channels.push({ name: "npm", path: whichOut, isDevLink: isDev });
      }
    }
  } catch { /* not on PATH */ }

  // 3. Plugin bin wrapper
  const plugin = findPlugin(home);
  if (plugin) {
    const pluginBin = join(plugin.installPath, "bin", "skillwiki");
    if (existsSync(pluginBin)) {
      channels.push({ name: "plugin", path: pluginBin, isDevLink: false });
    }
  }

  // 4. CLI install bin
  const installBin = join(home, ".claude", "skills", "bin", "skillwiki");
  if (existsSync(installBin)) {
    channels.push({ name: "install", path: installBin, isDevLink: false });
  }

  return channels;
}

function isDevSymlink(binPath: string): boolean {
  try {
    const st = lstatSync(binPath);
    if (st.isSymbolicLink()) {
      const target = resolve(binPath, "..", readlinkSync(binPath));
      return target.includes("packages/cli") || target.includes("packages\\cli");
    }
  } catch { /* not a symlink or unreadable */ }
  return false;
}

function checkCliChannels(argv: string[], home: string): CheckResult {
  const channels = detectCliChannels(argv, home);

  if (channels.length === 0) {
    return check("warn", "cli_channels", "CLI channels", "skillwiki not found on any channel");
  }

  if (channels.length === 1) {
    const ch = channels[0];
    const label = ch.isDevLink ? `${ch.name} (dev source)` : ch.name;
    return check("pass", "cli_channels", "CLI channels", `Single channel: ${label}`);
  }

  // Multiple channels — check if any overlap with dev source
  const devChannels = channels.filter(c => c.isDevLink);
  const prodChannels = channels.filter(c => !c.isDevLink);

  if (devChannels.length > 0 && prodChannels.length > 0) {
    const hasInstall = prodChannels.some(c => c.name === "install");
    if (!hasInstall) {
      const devNames = devChannels.map(c => `${c.name}(dev)`);
      const prodNames = prodChannels.map(c => c.name);
      return check("pass", "cli_channels", "CLI channels", `${channels.length} channels: ${[...devNames, ...prodNames].join(", ")} — dev source with installed production channels`);
    }
    // Dev + prod channels coexist — this is the overlap case
    const devNames = devChannels.map(c => `${c.name}(dev)`);
    const prodNames = prodChannels.map(c => c.name);
    return check(
      "warn",
      "cli_channels",
      "CLI channels",
      `${channels.length} channels: ${[...devNames, ...prodNames].join(", ")} — dev and prod binaries overlap; dev repo should use project-local settings only`
    );
  }

  // Multiple prod channels — only warn if install channel is present (true duplicate)
  const names = channels.map(c => c.name);
  const hasInstall = channels.some(c => c.name === "install");
  if (hasInstall) {
    return check(
      "warn",
      "cli_channels",
      "CLI channels",
      `${channels.length} channels: ${names.join(", ")} — remove unused install with: rm ~/.claude/skills/bin/skillwiki`
    );
  }
  // npm + plugin (or other non-install combos) are legitimate — versions checked separately
  return check("pass", "cli_channels", "CLI channels", `${channels.length} channels: ${names.join(", ")}`);
}

function isDevSourceRun(argv: string[]): boolean {
  return argv.length >= 2 && argv[1].endsWith("cli.js");
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
  } catch (e: unknown) {
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
    const found = findInstalledSkillMd(srcDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (source)`);
    }
  }
  const plugin = findPlugin(home);
  if (plugin) {
    const found = findInstalledSkillMd(plugin.installPath);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (plugin v${plugin.version})`);
    }
  }
  const skillsDir = join(home, ".claude", "skills");
  if (existsSync(skillsDir)) {
    const found = findInstalledSkillMd(skillsDir);
    if (found.length > 0) {
      return check("pass", "skills_installed", "Skills installed", `${found.length} SKILL.md file(s) found (CLI install)`);
    }
  }
  return check("warn", "skills_installed", "Skills installed", "No SKILL.md files found");
}

function checkDuplicateSkills(home: string): CheckResult {
  const plugin = findPlugin(home);
  const skillsDir = join(home, ".claude", "skills");
  const agentSkillDirs = [
    { label: "~/.codex/skills/", path: join(home, ".codex", "skills") },
    { label: "~/.agents/skills/", path: join(home, ".agents", "skills") },
  ];

  // No plugin means no reference set to compare against
  if (!plugin) {
    return check("pass", "skills_duplicate", "Skills not duplicated", "Single install channel");
  }

  const pluginSkills = findSkillNames(plugin.installPath);

  // Check ~/.claude/skills/ overlap (warn — user should remove CLI copies)
  const cliSkills = findSkillNames(skillsDir);
  const cliDuplicates = cliSkills.filter(name => pluginSkills.includes(name));

  // Check agent-skill dirs overlap (info — stale but harmless)
  const agentDuplicates: { dir: string; names: string[] }[] = [];
  for (const { label, path } of agentSkillDirs) {
    const overlap = findSkillNames(path).filter(name => pluginSkills.includes(name));
    if (overlap.length > 0) {
      agentDuplicates.push({ dir: label, names: overlap });
    }
  }

  if (cliDuplicates.length === 0 && agentDuplicates.length === 0) {
    return check("pass", "skills_duplicate", "Skills not duplicated", "No overlap between plugin and other channels");
  }

  // Build detail message
  const parts: string[] = [];
  if (cliDuplicates.length > 0) {
    parts.push(`${cliDuplicates.length} skill(s) in both plugin and ~/.claude/skills/ — remove CLI copies: rm -r ~/.claude/skills/{${cliDuplicates.slice(0, 3).join(",")}${cliDuplicates.length > 3 ? ",…" : ""}}`);
  }
  for (const { dir, names } of agentDuplicates) {
    parts.push(`${names.length} stale skill(s) in ${dir} — plugin provides: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`);
  }

  // CLI duplicates are warn; agent-only duplicates are info
  const status: CheckStatus = cliDuplicates.length > 0 ? "warn" : "info";
  return check(status, "skills_duplicate", "Skills not duplicated", parts.join("; "));
}

function checkNpmUpdate(home: string, currentVersion: string): CheckResult {
  const { hasUpdate, latest, distTag } = latestFromCache(home, currentVersion);
  if (!latest) {
    return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (${distTag}: no cache yet)`);
  }
  if (hasUpdate) {
    return check("warn", "npm_update", "npm CLI version", `v${currentVersion} — ${distTag} update available: v${latest}. Run \`skillwiki update --tag ${distTag}\`.`);
  }
  return check("pass", "npm_update", "npm CLI version", `v${currentVersion} (${distTag}: v${latest})`);
}

function checkPluginVersionDrift(home: string, currentVersion: string, devSourceRun: boolean): CheckResult {
  const plugins = findPluginInstallations(home);
  if (plugins.length === 0) {
    return check("pass", "plugin_version_drift", "Plugin/CLI version", "Plugin not installed — CLI only");
  }

  const drifted = plugins.filter(plugin => plugin.version !== currentVersion);
  if (drifted.length === 0) {
    if (plugins.length === 1 && plugins[0].channel === "claude") {
      return check("pass", "plugin_version_drift", "Plugin/CLI version", `Both at v${currentVersion}`);
    }
    if (plugins.length === 1) {
      return check("pass", "plugin_version_drift", "Plugin/CLI version", `${plugins[0].label} plugin and CLI both at v${currentVersion}`);
    }
    const labels = plugins.map(plugin => `${plugin.label} plugin`).join(", ");
    return check("pass", "plugin_version_drift", "Plugin/CLI version", `${labels}, and CLI all at v${currentVersion}`);
  }

  if (devSourceRun && drifted.every(plugin => semverGt(currentVersion, plugin.version))) {
    const details = drifted.map(plugin => `${plugin.label} plugin v${plugin.version}`).join(", ");
    return check("info", "plugin_version_drift", "Plugin/CLI version", `Dev source v${currentVersion} is ahead of installed ${details}`);
  }

  const details = drifted.map(plugin => {
    const updateCmd = pluginUpdateCommand(plugin, currentVersion);
    return `${plugin.label} plugin v${plugin.version} ≠ CLI v${currentVersion} — run \`${updateCmd}\``;
  });
  return check(
    "warn",
    "plugin_version_drift",
    "Plugin/CLI version",
    details.join("; ")
  );
}

function pluginUpdateCommand(plugin: PluginChannelInstall, currentVersion: string): string {
  if (semverGt(plugin.version, currentVersion)) {
    return "npm install -g skillwiki@latest";
  }
  if (plugin.channel === "claude") {
    return "claude plugin update skillwiki@llm-wiki";
  }
  if (plugin.sourceType === "git") {
    return "codex plugin marketplace upgrade llm-wiki && codex plugin remove skillwiki@llm-wiki && codex plugin add skillwiki@llm-wiki";
  }
  return "codex plugin remove skillwiki@llm-wiki && codex plugin add skillwiki@llm-wiki";
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

function hasOriginMain(resolvedPath: string): boolean {
  try {
    execSync("git rev-parse --verify --quiet origin/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function checkVaultGitDirty(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_git_dirty", "Vault git dirty state", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_git_dirty", "Vault git dirty state", "No git repo — check skipped");
  }
  try {
    const lines = execSync("git status --porcelain", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      return check("warn", "vault_git_dirty", "Vault git dirty state", `${lines.length} dirty file(s) in vault worktree`);
    }
    return check("pass", "vault_git_dirty", "Vault git dirty state", "Clean worktree");
  } catch {
    return check("warn", "vault_git_dirty", "Vault git dirty state", "Could not read git status");
  }
}

function checkVaultGitAhead(resolvedPath: string | undefined): CheckResult {
  return checkVaultGitComparison(
    resolvedPath,
    "vault_git_ahead",
    "Vault commits ahead",
    "origin/main..HEAD",
    "ahead of origin/main",
    "0 commits ahead of origin/main",
  );
}

function checkVaultGitBehind(resolvedPath: string | undefined): CheckResult {
  const staleRemote = checkStaleRemoteMain(resolvedPath);
  if (staleRemote) return staleRemote;
  return checkVaultGitComparison(
    resolvedPath,
    "vault_git_behind",
    "Vault commits behind",
    "HEAD..origin/main",
    "behind origin/main",
    "0 commits behind origin/main",
  );
}

function gitRefHash(resolvedPath: string, ref: string): string | undefined {
  try {
    const out = execSync(`git rev-parse --verify ${ref}`, {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function remoteMainHash(resolvedPath: string): string | undefined {
  try {
    const out = execSync("git ls-remote origin refs/heads/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    const hash = out.split(/\s+/)[0];
    return /^[0-9a-f]{40}$/i.test(hash) ? hash : undefined;
  } catch {
    return undefined;
  }
}

function checkStaleRemoteMain(resolvedPath: string | undefined): CheckResult | undefined {
  if (resolvedPath === undefined) return undefined;
  if (!existsSync(join(resolvedPath, ".git"))) return undefined;
  const localOrigin = gitRefHash(resolvedPath, "origin/main");
  if (!localOrigin) return undefined;
  const remoteMain = remoteMainHash(resolvedPath);
  if (!remoteMain || remoteMain === localOrigin) return undefined;
  return check("warn", "vault_git_behind", "Vault commits behind",
    `Remote main differs from local origin/main (${remoteMain.slice(0, 8)} != ${localOrigin.slice(0, 8)}) — run git fetch before trusting behind count`);
}

function checkVaultLocalGit(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("error", "vault_local_git", "Vault local git", "Cannot check — WIKI_PATH not resolved");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("error", "vault_local_git", "Vault local git", "Not a git repository — local vault metadata unusable for sync");
  }
  try {
    execSync("git rev-parse --git-dir", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    });
    return check("pass", "vault_local_git", "Vault local git", "Git metadata readable");
  } catch {
    return check("error", "vault_local_git", "Vault local git", "Git metadata unreadable — local vault may be corrupt");
  }
}

function checkVaultGithubRemote(
  resolvedPath: string | undefined,
  exec?: ExecProbe,
): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "No git repo — check skipped");
  }
  const state = probeGithubReachability(resolvedPath, exec);
  if (state === "ok") {
    return check("pass", "vault_github_remote", "Vault GitHub remote", "git ls-remote origin main succeeded");
  }
  if (state === "unreachable") {
    return check("warn", "vault_github_remote", "Vault GitHub remote", "GitHub unreachable (ls-remote failed) — local vault still usable");
  }
  return check("pass", "vault_github_remote", "Vault GitHub remote", "No origin remote — network probe skipped");
}

function checkVaultS3Remote(home: string, exec?: ExecProbe): CheckResult {
  const remote = readWikiS3RemoteFromEnv(home);
  const state = probeS3Reachability(remote, exec);
  if (state === "ok") {
    return check("pass", "vault_s3_remote", "Vault S3 remote", `rclone lsf ${remote} succeeded`);
  }
  if (state === "unreachable") {
    return check("warn", "vault_s3_remote", "Vault S3 remote", `S3 remote unreachable (${remote}) — local/GitHub work may continue`);
  }
  return check("warn", "vault_s3_remote", "Vault S3 remote", "S3 remote not configured — probe skipped");
}

function snapshotterAliasForLocalHost(
  fleetLoad: FleetManifestAndHost | null,
): string | undefined {
  if (!fleetLoad?.manifest || !fleetLoad.hostId) return undefined;
  const snapshotterId = Object.entries(fleetLoad.manifest.hosts).find(([, h]) => h.role === "snapshotter")?.[0];
  if (!snapshotterId) return undefined;
  const profile = fleetLoad.manifest.hosts[snapshotterId]?.access?.from?.[fleetLoad.hostId];
  if (!profile || (profile.status !== "configured" && profile.status !== "local")) return undefined;
  const aliases = profile.ssh_aliases ?? [];
  return aliases.length > 0 ? aliases[0] : undefined;
}

function checkVaultSnapshotterReachable(
  fleetLoad: FleetManifestAndHost | null,
  checkSnapshotter: boolean | undefined,
  exec?: ExecProbe,
): CheckResult {
  if (!checkSnapshotter) {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", "Snapshotter SSH probe not requested — check skipped");
  }
  const alias = snapshotterAliasForLocalHost(fleetLoad);
  if (!alias) {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", "No declared SSH alias from this host — check skipped");
  }
  const state = probeSnapshotterSsh(alias, exec);
  if (state === "ok") {
    return check("pass", "vault_snapshotter_reachable", "Vault snapshotter host", `SSH reachable via ${alias}`);
  }
  return check("warn", "vault_snapshotter_reachable", "Vault snapshotter host", `Snapshotter unreachable via ${alias} — not a local vault corruption signal`);
}

function checkVaultPromotionLag(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "No git repo — check skipped");
  }
  try {
    const out = execSync("git log -1 --format=%ct origin/main", {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
    }).trim();
    const ts = parseInt(out, 10);
    if (!Number.isFinite(ts) || ts <= 0) {
      return check("pass", "vault_promotion_lag", "Vault promotion lag", "origin/main timestamp unavailable — check skipped");
    }
    const ageHours = Math.floor((Date.now() / 1000 - ts) / 3600);
    if (ageHours > 48) {
      return check("warn", "vault_promotion_lag", "Vault promotion lag", `Local origin/main snapshot is ${ageHours}h old — verify snapshotter/GitHub when online`);
    }
    return check("pass", "vault_promotion_lag", "Vault promotion lag", `origin/main age ${ageHours}h`);
  } catch {
    return check("pass", "vault_promotion_lag", "Vault promotion lag", "Could not read origin/main — check skipped");
  }
}

function checkVaultGitComparison(
  resolvedPath: string | undefined,
  id: string,
  label: string,
  range: string,
  nonZeroSuffix: string,
  zeroDetail: string,
): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", id, label, "No vault path — check skipped");
  }
  if (!existsSync(join(resolvedPath, ".git"))) {
    return check("pass", id, label, "No git repo — check skipped");
  }
  if (!hasOriginMain(resolvedPath)) {
    return check("pass", id, label, "origin/main unavailable — check skipped");
  }
  try {
    const count = parseInt(execSync(`git rev-list --count ${range}`, {
      cwd: resolvedPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(), 10);
    if (count > 0) {
      return check("warn", id, label, `${count} commit(s) ${nonZeroSuffix}`);
    }
    return check("pass", id, label, zeroDetail);
  } catch {
    return check("warn", id, label, "Could not compare HEAD with origin/main");
  }
}

export function checkSatelliteLastRun(vaultPath: string | undefined, satelliteExpected: boolean): CheckResult {
  if (!satelliteExpected) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "Satellite job not expected on this host");
  }
  if (vaultPath === undefined) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "No vault path — check skipped");
  }
  const latestPath = satelliteLatestRunPath(vaultPath);
  if (!existsSync(latestPath)) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "No latest-run.json — satellite has not run yet");
  }
  try {
    const health = evaluateSatelliteRunHealth(vaultPath, new Date());
    if (health.failed) {
      const fc = health.failureClass;
      const detail = fc ? `Last satellite run failed (failure_class: ${fc})` : "Last satellite run failed";
      return check("error", "satellite_job_last_run", "Satellite job last run", detail);
    }
    if (health.stale && health.finishedAt) {
      return check(
        "warn",
        "satellite_job_last_run",
        "Satellite job last run",
        `Last run finished_at is older than 26h (${health.finishedAt})`
      );
    }
    return check(
      "pass",
      "satellite_job_last_run",
      "Satellite job last run",
      health.finishedAt ? `Last run ok (finished_at ${health.finishedAt})` : "Last run ok"
    );
  } catch {
    return check("warn", "satellite_job_last_run", "Satellite job last run", `Could not read ${latestPath}`);
  }
}

export interface SatelliteTimerDeps {
  platform: () => NodeJS.Platform;
  systemctlIsActive: (unit: string) => string | undefined;
}

function defaultSatelliteTimerDeps(): SatelliteTimerDeps {
  return {
    platform: () => platform(),
    systemctlIsActive: (unit) => {
      try {
        return execSync(`systemctl is-active ${unit}`, {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return undefined;
      }
    },
  };
}

export function checkSatelliteTimer(
  satelliteExpected: boolean,
  deps: SatelliteTimerDeps = defaultSatelliteTimerDeps()
): CheckResult {
  if (!satelliteExpected) {
    return check("pass", "satellite_job_timer", "Satellite job timer", "Satellite job not expected on this host");
  }
  if (deps.platform() !== "linux") {
    return check("pass", "satellite_job_timer", "Satellite job timer", "Timer check skipped — Linux only");
  }
  const out = deps.systemctlIsActive("agent-memory-trends.timer");
  if (out === undefined) {
    return check("pass", "satellite_job_timer", "Satellite job timer", "systemctl unavailable");
  }
  if (out === "active") {
    return check("pass", "satellite_job_timer", "Satellite job timer", "systemd: agent-memory-trends.timer active");
  }
  return check(
    "error",
    "satellite_job_timer",
    "Satellite job timer",
    `systemd: agent-memory-trends.timer is ${out || "not active"}`
  );
}

async function checkFleetIdentity(input: {
  vaultPath?: string;
  home: string;
  cwd?: string;
  envValue?: string;
  fleetLoad?: FleetManifestAndHost | null;
}): Promise<CheckResult> {
  if (!input.vaultPath) {
    return check("pass", "fleet_identity", "Fleet identity", "No vault path — check skipped");
  }

  const load =
    input.fleetLoad !== undefined
      ? input.fleetLoad
      : await loadFleetManifestAndHost({
          vault: input.vaultPath,
          env: { ...process.env, WIKI_PATH: input.envValue ?? input.vaultPath },
          home: input.home,
          cwd: input.cwd ?? process.cwd(),
          osHostname: process.env.HOSTNAME,
          user: process.env.USER,
        });

  if (!load) {
    return check("pass", "fleet_identity", "Fleet identity", "Fleet manifest unavailable — check skipped");
  }
  if (load.identityStatus === "known") {
    return check("pass", "fleet_identity", "Fleet identity", `Resolved ${load.hostId ?? "unknown"} via ${load.source ?? "unknown"}`);
  }

  const detail = load.warnings.length > 0 ? load.warnings.join("; ") : "Fleet identity is unresolved";
  return check("warn", "fleet_identity", "Fleet identity", detail);
}

function pullLogPaths(home: string): string[] {
  const paths = platform() === "darwin"
    ? [
      join(home, "Library", "Logs", "wiki-pull.log"),
      join(home, ".local", "state", "vault-sync", "log", "wiki-pull.log"),
    ]
    : [
      join(home, ".local", "state", "vault-sync", "log", "wiki-pull.log"),
      join(home, "Library", "Logs", "wiki-pull.log"),
    ];
  return [...new Set(paths)];
}

function isRecentLogLine(line: string, nowMs: number): boolean {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
  if (!match) return true;
  const ts = Date.parse(match[1]);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts <= 24 * 60 * 60 * 1000;
}

function checkVaultGitPullFailures(home: string): CheckResult {
  const path = pullLogPaths(home).find(p => existsSync(p));
  if (!path) {
    return check("pass", "vault_git_pull_failures", "Vault pull failures", "No wiki-pull.log found — check skipped");
  }
  try {
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
    const now = Date.now();
    const failures = lines.filter(line =>
      isRecentLogLine(line, now) &&
      /(pre-push pull failed|FAIL .*pull|FAIL .*rebase|cannot pull with rebase|unstaged changes)/i.test(line)
    );
    if (failures.length > 0) {
      const sample = failures.slice(-2).map(line => line.slice(0, 100)).join(" | ");
      return check("warn", "vault_git_pull_failures", "Vault pull failures", `${failures.length} recent pull failure(s): ${sample}`);
    }
    return check("pass", "vault_git_pull_failures", "Vault pull failures", "No recent pull failures logged");
  } catch {
    return check("warn", "vault_git_pull_failures", "Vault pull failures", `Could not read ${path}`);
  }
}

function checkS3MountPerf(resolvedPath: string | undefined): CheckResult {
  if (resolvedPath === undefined) {
    return check("pass", "s3_mount_perf", "S3 mount performance", "No vault path — check skipped");
  }

  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_mount_perf", "S3 mount performance", "local disk");
  }
  const mountPoint = fuse.mountPoint;

  const conceptsDir = join(resolvedPath, "concepts");
  if (!existsSync(conceptsDir)) {
    return check("pass", "s3_mount_perf", "S3 mount performance", `S3 FUSE mount (${mountPoint}), no concepts/ to benchmark`);
  }

  const start = Date.now();
  let timedOut = false;
  try {
    execSync(`rg -l "." "${conceptsDir}"`, {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    if (e.killed || (e.status === null && e.signal === "SIGTERM")) {
      timedOut = true;
    } else if (e.code === "ENOENT") {
      return check(
        "info",
        "s3_mount_perf",
        "S3 mount performance",
        `S3 FUSE mount (${mountPoint}) — rg not found at runtime, benchmark skipped`
      );
    }
    // rg exits 1 on no matches (or 2 on error) — both still completed, use elapsed time
  }
  const elapsed = (Date.now() - start) / 1000;

  if (timedOut || elapsed >= 3) {
    return check(
      "warn",
      "s3_mount_perf",
      "S3 mount performance",
      `S3 FUSE mount (${mountPoint}) with cold cache (rg scan: >3s). Vault scans may exceed 60s. Consider running wiki-cache-warm or checking rclone-wiki.service.`
    );
  }

  return check(
    "pass",
    "s3_mount_perf",
    "S3 mount performance",
    `S3 FUSE mount, cache warm (rg scan: ${elapsed.toFixed(3)}s)`
  );
}

const MAX_DIR_CACHE_TIME_SECONDS = 15 * 60;

function formatDurationForHumans(seconds: number): string {
  if (!Number.isFinite(seconds)) return `${seconds}s`;
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds >= 1) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds * 1000)}ms`;
}

/** Check freshness envelope for cross-device S3 visibility (dir-cache-time). */
function checkS3MountFreshness(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "s3_mount_freshness", "S3 visibility freshness", "No vault path — check skipped");
  }

  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_mount_freshness", "S3 visibility freshness", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `S3 FUSE mount (${fuse.mountPoint}) but no rclone process found — cannot audit --dir-cache-time`
    );
  }

  const flags = parseRcloneFlags(pid);
  if (flags.size === 0) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `rclone PID ${pid} found but could not parse flags`
    );
  }

  const raw = flags.get("--dir-cache-time");
  if (!raw) {
    return check(
      "pass",
      "s3_mount_freshness",
      "S3 visibility freshness",
      "PID " + pid + ": --dir-cache-time not set (rclone default 5m, within <=15m SLA)"
    );
  }

  const seconds = parseDurationSeconds(raw);
  if (seconds === null) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `PID ${pid}: could not parse --dir-cache-time=${raw}`
    );
  }

  if (seconds > MAX_DIR_CACHE_TIME_SECONDS) {
    return check(
      "warn",
      "s3_mount_freshness",
      "S3 visibility freshness",
      `PID ${pid}: --dir-cache-time=${raw} (${formatDurationForHumans(seconds)}) exceeds 15m SLA — external S3 changes may remain invisible`
    );
  }

  return check(
    "pass",
    "s3_mount_freshness",
    "S3 visibility freshness",
    `PID ${pid}: --dir-cache-time=${raw} (${formatDurationForHumans(seconds)}), within <=15m SLA`
  );
}

// ── S3 mount health checks (A–E) ────────────────────────────

/** Check A: rclone flag audit — are critical VFS flags set to safe values? */
function checkRcloneFlagAudit(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "rclone_flags", "rclone VFS flags", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "rclone_flags", "rclone VFS flags", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check("warn", "rclone_flags", "rclone VFS flags", `S3 FUSE mount (${fuse.mountPoint}) but no rclone process found — cannot audit flags`);
  }

  const flags = parseRcloneFlags(pid);
  if (flags.size === 0) {
    return check("warn", "rclone_flags", "rclone VFS flags", `rclone PID ${pid} found but could not parse flags`);
  }

  const warnings: string[] = [];
  for (const [flag, threshold] of Object.entries(FLAG_THRESHOLDS)) {
    const raw = flags.get(flag);
    if (raw === undefined) {
      warnings.push(`${flag} not set (default may be unsafe)`);
      continue;
    }
    const inSeconds = parseDurationSeconds(raw);
    if (inSeconds === null) continue;
    const thresholdSec = threshold.unit === "h" ? threshold.min * 3600 : threshold.unit === "m" ? threshold.min * 60 : threshold.min;
    if (inSeconds < thresholdSec) {
      warnings.push(`${flag}=${raw} (recommended ≥${threshold.min}${threshold.unit})`);
    }
  }

  // Bonus: check for --vfs-cache-mode
  const cacheMode = flags.get("--vfs-cache-mode");
  if (!cacheMode) {
    warnings.push("--vfs-cache-mode not set (recommended: full)");
  } else if (cacheMode !== "full") {
    warnings.push(`--vfs-cache-mode=${cacheMode} (recommended: full)`);
  }

  // Bonus: check for --log-file
  if (!flags.has("--log-file")) {
    warnings.push("--log-file not set — no rclone error log configured");
  }

  if (warnings.length > 0) {
    return check("warn", "rclone_flags", "rclone VFS flags", warnings.join("; "));
  }
  return check("pass", "rclone_flags", "rclone VFS flags", `PID ${pid}: all critical flags at safe values`);
}

/** Check B: rclone version — does it support --vfs-write-wait? */
function checkRcloneVersion(resolvedPath: string | undefined, vaultSyncInstalled: boolean): CheckResult {
  if (!resolvedPath && !vaultSyncInstalled) {
    return check("pass", "rclone_version", "rclone version", "No vault path — check skipped");
  }
  const fuse = resolvedPath ? detectFuseMount(resolvedPath) : null;
  if (!fuse && !vaultSyncInstalled) {
    return check("pass", "rclone_version", "rclone version", "local disk — check skipped");
  }

  const ver = getRcloneVersion();
  if (!ver) {
    return check("warn", "rclone_version", "rclone version", "rclone not found on PATH — cannot verify version");
  }

  const min = MIN_RCLONE_VERSION;
  const tooOld = ver.major < min.major ||
    (ver.major === min.major && ver.minor < min.minor) ||
    (ver.major === min.major && ver.minor === min.minor && ver.patch < min.patch);

  if (tooOld) {
    return check(
      "warn",
      "rclone_version",
      "rclone version",
      `${ver.raw} — upgrade to ≥v${min.major}.${min.minor}.${min.patch} for --vfs-write-wait support (current version may silently ignore this flag)`
    );
  }
  return check("pass", "rclone_version", "rclone version", ver.raw);
}

/** Check C: write-then-read test — can the vault actually write and read files? */
function checkWriteTest(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "s3_write_test", "S3 write test", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "s3_write_test", "S3 write test", "local disk — check skipped");
  }

  const conceptsDir = join(resolvedPath, "concepts");
  if (!existsSync(conceptsDir)) {
    return check("pass", "s3_write_test", "S3 write test", "no concepts/ dir to test — check skipped");
  }

  const result = writeTest(conceptsDir);

  if (result.success) {
    const totalMs = result.writeMs + result.readMs;
    if (totalMs > 3000) {
      return check("warn", "s3_write_test", "S3 write test",
        `write+read ${totalMs}ms (write ${result.writeMs}ms, read ${result.readMs}ms, ${result.size}B) — S3 mount is slow`);
    }
    return check("pass", "s3_write_test", "S3 write test",
      `write+read ${totalMs}ms (write ${result.writeMs}ms, read ${result.readMs}ms)`);
  }
  return check("warn", "s3_write_test", "S3 write test",
    `${result.error} — S3 mount may have a stale FUSE handle or write-back failure`);
}

/** Check D: VFS cache health via rclone RC endpoint. */
function checkVfsCacheHealth(resolvedPath: string | undefined): CheckResult {
  if (!resolvedPath) {
    return check("pass", "vfs_cache_health", "VFS cache health", "No vault path — check skipped");
  }
  const fuse = detectFuseMount(resolvedPath);
  if (!fuse) {
    return check("pass", "vfs_cache_health", "VFS cache health", "local disk — check skipped");
  }

  const pid = findRcloneMountPid();
  if (pid === null) {
    return check("warn", "vfs_cache_health", "VFS cache health", "no rclone process found — cannot query VFS stats");
  }

  const flags = parseRcloneFlags(pid);
  const rcAddr = flags.get("--rc-addr") || "127.0.0.1:5572";

  // Only query if --rc flag is present
  if (!flags.has("--rc")) {
    return check("info", "vfs_cache_health", "VFS cache health",
      `rclone RC not enabled — add --rc --rc-addr ${rcAddr} to enable cache health monitoring`);
  }

  // Extract the rclone remote path from the cmdline (e.g., "cloud:cloud/wiki")
  const args = getRcloneArgs(pid);
  const fs = extractRcloneFs(args) || "unknown:";

  const stats = queryRcloneRC(rcAddr, fs || "unknown:");
  if (!stats) {
    return check("warn", "vfs_cache_health", "VFS cache health",
      `RC endpoint ${rcAddr} unreachable — is rclone --rc enabled?`);
  }
  if (stats.error) {
    return check("warn", "vfs_cache_health", "VFS cache health", stats.error);
  }

  const issues: string[] = [];
  if (stats.uploadsInProgress > 0) issues.push(`${stats.uploadsInProgress} upload(s) in progress`);
  if (stats.uploadsQueued > 10) issues.push(`${stats.uploadsQueued} upload(s) queued (backlog)`);
  if (stats.erroredFiles > 0) issues.push(`${stats.erroredFiles} errored file(s)`);
  if (stats.outOfSpace) issues.push("cache disk full");

  if (issues.length > 0) {
    return check("warn", "vfs_cache_health", "VFS cache health",
      `${stats.files} files, ${stats.bytesUsed} bytes — ${issues.join("; ")}`);
  }
  return check("pass", "vfs_cache_health", "VFS cache health",
    `${stats.files} files, ${(stats.bytesUsed / 1024 / 1024).toFixed(1)}MB — clean (0 errored, 0 pending)`);
}

// ── Vault sync health checks (6 checks) ──────────────────────

interface VaultSyncRuntimeConfig {
  installed: boolean;
  role?: string;
  serviceScope?: string;
  snapshotScript?: string;
  snapshotProfile?: string;
  snapshotWorktree?: string;
}

/** Read vault_sync.* keys from the .env file bypassing the whitelist filter. */
function readVaultSyncConfig(home: string): VaultSyncRuntimeConfig {
  try {
    const content = readFileSync(join(home, ".skillwiki", ".env"), "utf8");
    let installed = false;
    let role: string | undefined;
    let serviceScope: string | undefined;
    let snapshotScript: string | undefined;
    let snapshotProfile: string | undefined;
    let snapshotWorktree: string | undefined;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (v.length === 0) continue;
      if (k === "vault_sync.installed" && v === "true") installed = true;
      if (k === "vault_sync.role") role = v;
      if (k === "vault_sync.service_scope") serviceScope = v;
      if (k === "vault_sync.snapshot_script") snapshotScript = v;
      if (k === "vault_sync.snapshot_profile") snapshotProfile = v;
      if (k === "vault_sync.snapshot_worktree") snapshotWorktree = v;
    }
    return { installed, role, serviceScope, snapshotScript, snapshotProfile, snapshotWorktree };
  } catch {
    return { installed: false };
  }
}

function readKeyFromEnvFile(path: string, keys: string[]): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!keys.includes(key)) continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value.length > 0) return value;
    }
  } catch { /* profile is optional */ }
  return undefined;
}

function resolveSnapshotGitWorktree(config: VaultSyncRuntimeConfig): string | undefined {
  if (config.snapshotWorktree) return config.snapshotWorktree;
  if (config.snapshotProfile) {
    const fromProfile = readKeyFromEnvFile(config.snapshotProfile, ["WIKI_GIT_WORKTREE", "SNAPSHOT_WORKTREE", "GIT_DIR"]);
    if (fromProfile) return fromProfile;
  }
  const defaultPath = "/root/wiki-git";
  return existsSync(defaultPath) ? defaultPath : undefined;
}

interface VaultSyncInput {
  home: string;
  vaultSyncInstalled: boolean;
  vaultSyncRole?: string;
  vaultSyncServiceScope?: string;
  os?: string;
  logDir?: string;
  shareDir?: string;
  filterPath?: string;
  snapshotScriptPath?: string;
}

/**
 * Six vault-sync health checks.
 *
 * Top-level skip: if vault_sync.installed is not true, all 6 return
 * pass-with-skip-detail.
 */
function vaultSyncChecks(input: VaultSyncInput): CheckResult[] {
  const os = input.os ?? platform();
  const home = input.home;

  // ── Top-level skip gate ──────────────────────────────────────
  if (!input.vaultSyncInstalled) {
    const skip = (id: string, label: string) =>
      check("pass", id, label, "vault-sync not installed — check skipped");
    return [
      skip("vault_sync_installed", "Vault sync installed"),
      skip("vault_sync_jobs_enabled", "Vault sync jobs enabled"),
      skip("vault_sync_last_push_age", "Vault sync last push recency"),
      skip("vault_sync_last_fetch_status", "Vault sync last fetch status"),
      skip("vault_sync_filter_present", "Vault sync filter file present"),
      skip("vault_sync_snapshot_guard", "Snapshot script guard"),
    ];
  }

  // ── Default paths (platform-aware) ──────────────────────────────
  const isMac = os === "darwin";
  const logDir =
    input.logDir ??
    (isMac
      ? join(home, "Library", "Logs")
      : join(home, ".local", "state", "vault-sync", "log"));
  const shareDir =
    input.shareDir ??
    (isMac
      ? join(home, "Library", "Application Support", "vault-sync", "bin")
      : join(home, ".local", "share", "vault-sync", "bin"));
  const filterPath =
    input.filterPath ?? join(home, ".config", "rclone", "wiki-push-filters.txt");
  const packagedSnapshotPath = join(shareDir, "wiki-snapshot.sh");
  const legacySnapshotPath = "/root/.hermes/scripts/wiki-snapshot-v3.sh";
  const snapshotPath =
    input.snapshotScriptPath ??
    (existsSync(packagedSnapshotPath) ? packagedSnapshotPath : legacySnapshotPath);

  function snapshotLastStatusCheck(): CheckResult {
    const snapshotLog = join(logDir, "wiki-snapshot.log");
    try {
      const logContent = readFileSync(snapshotLog, "utf8");
      const lines = logContent.trim().split("\n").filter(Boolean);
      if (lines.length === 0) {
        return check("warn", "vault_sync_last_push_age", "Vault sync last snapshot status",
          "Snapshot log file is empty");
      }
      const lastLine = [...lines].reverse().find(line =>
        /ERROR|Status: complete|Push successful|No changes to commit/.test(line)
      ) ?? lines[lines.length - 1];
      if (/ERROR/.test(lastLine)) {
        return check("error", "vault_sync_last_push_age", "Vault sync last snapshot status",
          `Last snapshot failed: ${lastLine.slice(0, 160)}`);
      }
      if (/Status: complete|Push successful|No changes to commit/.test(lastLine)) {
        return check("pass", "vault_sync_last_push_age", "Vault sync last snapshot status",
          lastLine.slice(0, 160));
      }
      return check("warn", "vault_sync_last_push_age", "Vault sync last snapshot status",
        `Last snapshot log entry: ${lastLine.slice(0, 160)}`);
    } catch {
      return check("warn", "vault_sync_last_push_age", "Vault sync last snapshot status",
        `Snapshot log not found at ${snapshotLog}`);
    }
  }

  if (input.vaultSyncRole === "snapshotter") {
    const c1 = existsSync(snapshotPath)
      ? check("pass", "vault_sync_installed", "Vault sync installed", `Found snapshot script: ${snapshotPath}`)
      : check("error", "vault_sync_installed", "Vault sync installed", `Snapshot script not found at ${snapshotPath}`);

    const serviceScope = input.vaultSyncServiceScope ?? "user";
    const userTimerPath = join(home, ".config", "systemd", "user", "wiki-snapshot.timer");
    const systemTimerPath = "/etc/systemd/system/wiki-snapshot.timer";
    let c2: CheckResult;
    if (serviceScope === "user" && existsSync(userTimerPath)) {
      c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `Found: ${userTimerPath}`);
    } else if (serviceScope === "system" && existsSync(systemTimerPath)) {
      c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `Found: ${systemTimerPath}`);
    } else if (os !== "linux") {
      c2 = check("warn", "vault_sync_jobs_enabled", "Vault sync jobs enabled", "Snapshotter scheduler is Linux-only and no wiki-snapshot.timer file was found");
    } else {
      try {
        const command = serviceScope === "system"
          ? "systemctl is-enabled wiki-snapshot.timer"
          : "systemctl --user is-enabled wiki-snapshot.timer";
        const out = execSync(command, {
          encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        c2 = out === "enabled"
          ? check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `systemd: wiki-snapshot.timer enabled (${serviceScope})`)
          : check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `systemd: wiki-snapshot.timer is ${out || "not enabled"} (${serviceScope})`);
      } catch {
        c2 = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled", `wiki-snapshot.timer check failed (${serviceScope})`);
      }
    }

    const c3 = snapshotLastStatusCheck();
    const cFetch = check("pass", "vault_sync_last_fetch_status", "Vault sync last fetch status",
      "Snapshotter host — leaf wiki-fetch-notify log not applicable");
    const c4 = check("pass", "vault_sync_filter_present", "Vault sync filter file present",
      "Snapshotter host — leaf wiki-push filter not applicable");

    let c5: CheckResult;
    try {
      if (!existsSync(snapshotPath)) {
        c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
          `Snapshot script not found at ${snapshotPath}`);
      } else {
        const content = readFileSync(snapshotPath, "utf8");
        if (!content.includes("--max-delete")) {
          c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
            `${snapshotPath} is missing --max-delete guard — dangerous without it`);
        } else {
          c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
            `--max-delete present in ${snapshotPath}`);
        }
      }
    } catch {
      c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
        `Cannot read ${snapshotPath}`);
    }

    return [c1, c2, c3, cFetch, c4, c5];
  }

  // ── Check 1: vault_sync_installed ──────────────────────────────
  const pushScriptPath = join(shareDir, "wiki-push.sh");
  const c1 = existsSync(pushScriptPath)
    ? check("pass", "vault_sync_installed", "Vault sync installed", `Found: ${pushScriptPath}`)
    : check("error", "vault_sync_installed", "Vault sync installed", `Script not found at ${pushScriptPath} — run vault-sync-install`);

  // ── Check 2: vault_sync_jobs_enabled ───────────────────────────
  let c2: CheckResult;
  try {
    if (isMac) {
      const uidStr = execSync("id -u", {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const uid = parseInt(uidStr, 10);
      execSync(`launchctl print gui/${uid}/com.karlchow.wiki-push`, {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      });
      c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
        "launchd: com.karlchow.wiki-push loaded");
    } else {
      const out = execSync("systemctl --user is-enabled wiki-push.timer", {
        encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (out === "enabled") {
        c2 = check("pass", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
          "systemd: wiki-push.timer enabled");
      } else {
        c2 = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
          `systemd: wiki-push.timer is ${out} — run vault-sync-install`);
      }
    }
  } catch {
    c2 = check("error", "vault_sync_jobs_enabled", "Vault sync jobs enabled",
      "Scheduler check failed — run vault-sync-install");
  }

  // ── Check 3: vault_sync_last_push_age ──────────────────────────
  const logFile = join(logDir, "wiki-push.log");
  let c3: CheckResult;
  try {
    const logContent = readFileSync(logFile, "utf8");
    const lines = logContent.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      c3 = check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        "Log file is empty");
    } else {
      const lastLine = [...lines].reverse().find(line => /FAIL|OK push/.test(line)) ?? lines[lines.length - 1];
      if (/FAIL/.test(lastLine)) {
        c3 = check("error", "vault_sync_last_push_age", "Vault sync last push recency",
          `Last push failed: ${lastLine}`);
      } else if (/OK push/.test(lastLine)) {
        const tsMatch = lastLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/);
        if (tsMatch) {
          const lastPush = new Date(tsMatch[1]).getTime();
          const ageSec = (Date.now() - lastPush) / 1000;
          if (ageSec <= 180) {
            c3 = check("pass", "vault_sync_last_push_age", "Vault sync last push recency",
              `Last push ${ageSec.toFixed(0)}s ago`);
          } else {
            c3 = check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
              `Last push ${Math.round(ageSec)}s ago (>3 min)`);
          }
        } else {
          c3 = check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
          `Unparseable push line: ${lastLine.slice(0, 80)}`);
        }
      } else {
        c3 = check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
          `Last log entry: ${lastLine.slice(0, 80)}`);
      }
    }
  } catch {
    c3 = existsSync(logDir)
      ? check("warn", "vault_sync_last_push_age", "Vault sync last push recency",
        `Log file not found at ${logFile}`)
      : check("error", "vault_sync_last_push_age", "Vault sync last push recency",
        `Log directory not found at ${logDir}`);
  }

  // ── Check 4: vault_sync_last_fetch_status ──────────────────────
  // Separated from push because fetch and push are independent failure modes
  // (fetch never writes; push may fail while fetch succeeds, or vice versa).
  const fetchLogFile = join(logDir, "wiki-fetch.log");
  let cFetch: CheckResult;
  try {
    const logContent = readFileSync(fetchLogFile, "utf8");
    const lines = logContent.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
        "Fetch log file is empty");
    } else {
      const lastLine = lines[lines.length - 1];
      if (/fetch failed/i.test(lastLine)) {
        cFetch = check("error", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          `Last fetch failed: ${lastLine.slice(0, 100)}`);
      } else if (/OK/.test(lastLine)) {
        cFetch = check("pass", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          lastLine.slice(0, 100));
      } else {
        cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
          `Last fetch log entry: ${lastLine.slice(0, 80)}`);
      }
    }
  } catch {
    cFetch = check("warn", "vault_sync_last_fetch_status", "Vault sync last fetch status",
      `Fetch log not found at ${fetchLogFile}`);
  }

  // ── Check 5: vault_sync_filter_present ─────────────────────────
  let c4: CheckResult;
  try {
    if (!existsSync(filterPath)) {
      c4 = check("error", "vault_sync_filter_present", "Vault sync filter file present",
        `Filter file not found at ${filterPath}`);
    } else {
      const content = readFileSync(filterPath, "utf8");
      const requiredExcludes = [
        "remotely-save/data.json",
        ".skillwiki/sync.lock",
        ".skillwiki/memory/",
        ".skillwiki/memory-topics.json",
        ".claude/settings.local.json",
      ];
      const missing = requiredExcludes.filter(ex => !content.includes(ex));
      if (missing.length > 0) {
        c4 = check("warn", "vault_sync_filter_present", "Vault sync filter file present",
          `Missing required excludes: ${missing.join(", ")}`);
      } else {
        c4 = check("pass", "vault_sync_filter_present", "Vault sync filter file present",
          `Found with required excludes at ${filterPath}`);
      }
    }
  } catch {
    c4 = check("error", "vault_sync_filter_present", "Vault sync filter file present",
      `Cannot read filter file at ${filterPath}`);
  }

  // ── Check 6: vault_sync_snapshot_guard (snapshotter only) ─────
  let c5: CheckResult;
  if (input.vaultSyncRole !== "snapshotter") {
    c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
      "Not a snapshotter host — check skipped");
  } else {
    try {
      if (!existsSync(snapshotPath)) {
        c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
          `Snapshot script not found at ${snapshotPath}`);
      } else {
        const content = readFileSync(snapshotPath, "utf8");
        if (!content.includes("--max-delete")) {
          c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
            `${snapshotPath} is missing --max-delete guard — dangerous without it`);
        } else {
          c5 = check("pass", "vault_sync_snapshot_guard", "Snapshot script guard",
            `--max-delete present in ${snapshotPath}`);
        }
      }
    } catch {
      c5 = check("error", "vault_sync_snapshot_guard", "Snapshot script guard",
        `Cannot read ${snapshotPath}`);
    }
  }

  return [c1, c2, c3, cFetch, c4, c5];
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

function findInstalledSkillMd(dir: string): string[] {
  const directSkills = findSkillNames(dir).map(name => join(dir, name, "SKILL.md"));
  return directSkills.length > 0 ? directSkills : findSkillMd(dir);
}

/** Return skill directory names (e.g. "wiki-init", "proj-decide") that contain a SKILL.md. */
function findSkillNames(dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md"))) {
      results.push(entry.name);
    }
  }
  return results;
}

const METRIC_TYPES = ["entities", "concepts", "comparisons", "queries", "meta"];

/**
 * Vault graph/health metrics (info severity — never affect exit code).
 * Always returns exactly 5 rows so the doctor check count stays stable;
 * when no vault is configured each row reports "no vault configured".
 * Reuses utils/community.ts (no duplicated graph pass).
 */
async function vaultMetrics(resolvedPath: string | undefined): Promise<CheckResult[]> {
  const ids = [
    ["vault_metric_pages", "Vault pages by type"],
    ["vault_metric_orphans", "Vault orphan rate"],
    ["vault_metric_bridges", "Vault bridge count"],
    ["vault_metric_cohesion", "Mean community cohesion"],
    ["vault_metric_log_size", "Vault log size"],
  ] as const;
  const noVault = (): CheckResult[] => ids.map(([id, label]) => check("info", id, label, "no vault configured"));

  if (!resolvedPath) return noVault();
  const scan = await scanVault(resolvedPath);
  if (!scan.ok) return noVault();

  const tk = scan.data.typedKnowledge;
  const perType = METRIC_TYPES.map(d => `${d} ${tk.filter(p => p.relPath.startsWith(d + "/")).length}`).join(", ");

  const adj = await buildWikilinkAdjacency(tk);
  const g = toUndirectedWeighted(adj);
  const nodes = [...g.keys()];
  const total = nodes.length;

  const orphanCount = nodes.filter(n => g.get(n)!.size === 0).length;
  const orphanRate = total > 0 ? Math.round((orphanCount / total) * 1000) / 10 : 0;

  const comm = louvain(g);
  const groups = new Map<number, string[]>();
  for (const [node, c] of comm) {
    const arr = groups.get(c);
    if (arr) arr.push(node); else groups.set(c, [node]);
  }
  const cohesions = [...groups.values()].filter(m => m.length >= 2).map(m => communityCohesion(m, g));
  const meanCohesion = cohesions.length > 0
    ? Math.round((cohesions.reduce((a, b) => a + b, 0) / cohesions.length) * 1000) / 1000
    : 0;

  let bridges = 0;
  for (const n of nodes) {
    const nbrComms = new Set<number>();
    for (const nb of g.get(n)!.keys()) nbrComms.add(comm.get(nb)!);
    if (nbrComms.size >= 3) bridges++;
  }

  let logLines = 0;
  try { logLines = readFileSync(join(resolvedPath, "log.md"), "utf8").split("\n").length; } catch { /* no log.md */ }

  return [
    check("info", "vault_metric_pages", "Vault pages by type", `${total} typed (${perType})`),
    check("info", "vault_metric_orphans", "Vault orphan rate", `${orphanRate}% (${orphanCount}/${total} degree-0)`),
    check("info", "vault_metric_bridges", "Vault bridge count", `${bridges} page(s) link >= 3 communities`),
    check("info", "vault_metric_cohesion", "Mean community cohesion", `${meanCohesion} across ${cohesions.length} communities (size >= 2)`),
    check("info", "vault_metric_log_size", "Vault log size", `${logLines} lines`),
  ];
}

export async function runDoctor(
  input: DoctorInput
): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
  const checks: CheckResult[] = [];
  const devSourceRun = isDevSourceRun(input.argv);

  // Read vault-sync config once at the top for all checks that need it
  const vsConfig = readVaultSyncConfig(input.home);

  checks.push(checkNodeVersion());
  checks.push(checkCliChannels(input.argv, input.home));
  checks.push(await checkConfigFile(input.home));
  checks.push(await checkProfiles(input.home));
  checks.push(await checkProjectLocalOverride(input.cwd));

  const resolved = await resolveRuntimePath({
    flag: undefined,
    envValue: input.envValue,
    home: input.home,
    cwd: input.cwd,
  });
  if (resolved.ok) {
    checks.push(check("pass", "wiki_path_set", "WIKI_PATH configured", `Resolved via ${resolved.data.source}: ${resolved.data.path}`));
  } else {
    checks.push(check("error", "wiki_path_set", "WIKI_PATH configured", "No vault configured. Run `skillwiki init` or pass --vault."));
  }
  const resolvedPath = resolved.ok ? resolved.data.path : undefined;
  const gitCheckPath = vsConfig.role === "snapshotter"
    ? (resolveSnapshotGitWorktree(vsConfig) ?? resolvedPath)
    : resolvedPath;

  checks.push(checkWikiPathExists(resolvedPath));
  checks.push(checkVaultStructure(resolvedPath));
  checks.push(checkObsidianTemplates(resolvedPath));
  checks.push(checkVaultGitRemote(gitCheckPath));
  const fleetLoad = resolvedPath
    ? await loadFleetManifestAndHost({
        vault: resolvedPath,
        env: { ...process.env, WIKI_PATH: input.envValue ?? resolvedPath },
        home: input.home,
        cwd: input.cwd,
        osHostname: process.env.HOSTNAME,
        user: process.env.USER,
      })
    : null;

  checks.push(await checkFleetIdentity({
    vaultPath: resolvedPath,
    home: input.home,
    cwd: input.cwd,
    envValue: input.envValue,
    fleetLoad,
  }));
  checks.push(checkSyncLastPush(gitCheckPath));
  checks.push(checkVaultGitDirty(gitCheckPath));
  checks.push(checkVaultGitAhead(gitCheckPath));
  checks.push(checkVaultGitBehind(gitCheckPath));
  checks.push(checkVaultGitPullFailures(input.home));
  checks.push(checkVaultLocalGit(gitCheckPath));
  checks.push(checkVaultGithubRemote(gitCheckPath, input.execProbe));
  checks.push(checkVaultS3Remote(input.home, input.execProbe));
  checks.push(checkVaultSnapshotterReachable(fleetLoad, input.checkSnapshotter, input.execProbe));
  checks.push(checkVaultPromotionLag(gitCheckPath));
  checks.push(checkDotStoreClean(resolvedPath));
  checks.push(checkVaultConflictMarkers(resolvedPath));
  checks.push(checkS3MountPerf(resolvedPath));
  checks.push(checkS3MountFreshness(resolvedPath));
  checks.push(checkRcloneFlagAudit(resolvedPath));
  checks.push(checkRcloneVersion(resolvedPath, vsConfig.installed));
  checks.push(checkWriteTest(resolvedPath));
  checks.push(checkVfsCacheHealth(resolvedPath));
  checks.push(checkSkillsInstalled(input.home, input.cwd));
  checks.push(checkDuplicateSkills(input.home));
  checks.push(checkNpmUpdate(input.home, input.currentVersion));
  checks.push(checkPluginVersionDrift(input.home, input.currentVersion, devSourceRun));

  // Vault-sync checks (6 checks, no exit code impact)
  checks.push(...vaultSyncChecks({
    home: input.home,
    vaultSyncInstalled: vsConfig.installed,
    vaultSyncRole: vsConfig.role,
    vaultSyncServiceScope: vsConfig.serviceScope,
    snapshotScriptPath: vsConfig.snapshotScript,
  }));

  const satelliteGate = satelliteGateFromFleetLoad(fleetLoad);
  checks.push(checkSatelliteLastRun(resolvedPath, satelliteGate.satelliteExpected));
  checks.push(checkSatelliteTimer(satelliteGate.satelliteExpected));

  // Vault graph/health metrics (5 info rows, no exit code impact)
  checks.push(...await vaultMetrics(resolvedPath));

  const summary = {
    pass: checks.filter(c => c.status === "pass").length,
    info: checks.filter(c => c.status === "info").length,
    warn: checks.filter(c => c.status === "warn").length,
    error: checks.filter(c => c.status === "error").length,
  };

  const exitCode = summary.error > 0
    ? ExitCode.DOCTOR_HAS_ERRORS
    : summary.warn > 0
      ? ExitCode.DOCTOR_HAS_WARNINGS
      : ExitCode.OK;

  const statusIcon: Record<CheckStatus, string> = { pass: "✓", info: "i", warn: "⚠", error: "✗" };
  const lines = checks.map(c => {
    const icon = statusIcon[c.status];
    const padded = c.label.padEnd(24);
    return `  ${icon} ${padded} ${c.detail}`;
  });
  lines.push("");
  const summaryParts = [`${summary.pass} pass`];
  if (summary.info > 0) summaryParts.push(`${summary.info} info`);
  summaryParts.push(`${summary.warn} warn`, `${summary.error} error`);
  lines.push(summaryParts.join(" · "));
  const humanHint = lines.join("\n");

  return { exitCode, result: ok({ checks, summary, humanHint }) };
}
