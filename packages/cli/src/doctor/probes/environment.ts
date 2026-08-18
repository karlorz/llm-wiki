import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { configPath } from "../../commands/config.js";
import { parseDotenvFile } from "../../utils/dotenv.js";
import { findPlugin } from "../../utils/plugin-registry.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

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

function checkWikiPathSet(ctx: DoctorContext): CheckResult {
  if (ctx.resolvedPath) {
    return check("pass", "wiki_path_set", "WIKI_PATH configured", `Resolved via ${ctx.wikiPathSource ?? "unknown"}: ${ctx.resolvedPath}`);
  }
  return check("error", "wiki_path_set", "WIKI_PATH configured", "No vault configured. Run `skillwiki init` or pass --vault.");
}

export const environmentProbe: DoctorProbe = {
  id: "environment",
  async run(ctx: DoctorContext): Promise<CheckResult[]> {
    return [
      checkNodeVersion(),
      checkCliChannels(ctx.input.argv, ctx.input.home),
      await checkConfigFile(ctx.input.home),
      await checkProfiles(ctx.input.home),
      await checkProjectLocalOverride(ctx.input.cwd),
      checkWikiPathSet(ctx),
    ];
  },
};
