import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { semverGt } from "./semver.js";

export interface PluginInstall {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginInstall[]>;
}

export interface PluginChannelInstall {
  channel: "claude" | "codex";
  label: "Claude" | "Codex";
  key: string;
  pluginName: string;
  marketplace: string;
  installPath: string;
  version: string;
  sourceType?: string;
  source?: string;
}

interface CodexPluginConfig {
  enabled: boolean;
  sourceType?: string;
  source?: string;
}

const REGISTRY_PATH = join(".claude", "plugins", "installed_plugins.json");
const CODEX_CONFIG_PATH = join(".codex", "config.toml");
const PLUGIN_KEY = "skillwiki@llm-wiki";

function readInstalledPlugins(home: string): InstalledPlugins | null {
  try {
    const raw = readFileSync(join(home, REGISTRY_PATH), "utf8");
    return JSON.parse(raw) as InstalledPlugins;
  } catch {
    return null;
  }
}

/** Look up a plugin by key (e.g. "skillwiki@llm-wiki"). Returns the first install entry or null. */
export function findPlugin(home: string, key: string = PLUGIN_KEY): PluginInstall | null {
  const registry = readInstalledPlugins(home);
  if (!registry?.plugins) return null;
  const entries = registry.plugins[key];
  if (!entries || entries.length === 0) return null;
  return entries[0];
}

export function findPluginInstallations(home: string, key: string = PLUGIN_KEY): PluginChannelInstall[] {
  const parsed = parsePluginKey(key);
  if (!parsed) return [];

  const installs: PluginChannelInstall[] = [];
  const claudePlugin = findPlugin(home, key);
  if (claudePlugin) {
    installs.push({
      channel: "claude",
      label: "Claude",
      key,
      pluginName: parsed.pluginName,
      marketplace: parsed.marketplace,
      installPath: claudePlugin.installPath,
      version: claudePlugin.version,
    });
  }

  const codexPlugin = findCodexPlugin(home, key, parsed.pluginName, parsed.marketplace);
  if (codexPlugin) installs.push(codexPlugin);

  return installs;
}

function findCodexPlugin(
  home: string,
  key: string,
  pluginName: string,
  marketplace: string,
): PluginChannelInstall | null {
  const config = readCodexPluginConfig(home, key, marketplace);
  if (!config?.enabled) return null;

  const cacheRoot = join(home, ".codex", "plugins", "cache", marketplace, pluginName);
  if (!existsSync(cacheRoot)) return null;

  let versions: string[];
  try {
    versions = readdirSync(cacheRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return null;
  }
  if (versions.length === 0) return null;

  const version = versions.reduce((latest, candidate) => semverGt(candidate, latest) ? candidate : latest);
  return {
    channel: "codex",
    label: "Codex",
    key,
    pluginName,
    marketplace,
    installPath: join(cacheRoot, version),
    version,
    sourceType: config.sourceType,
    source: config.source,
  };
}

function parsePluginKey(key: string): { pluginName: string; marketplace: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  return {
    pluginName: key.slice(0, at),
    marketplace: key.slice(at + 1),
  };
}

function readCodexPluginConfig(home: string, key: string, marketplace: string): CodexPluginConfig | null {
  let raw: string;
  try {
    raw = readFileSync(join(home, CODEX_CONFIG_PATH), "utf8");
  } catch {
    return null;
  }

  const pluginSections = new Set([`plugins."${key}"`, `plugins.${key}`]);
  const marketplaceSections = new Set([`marketplaces.${marketplace}`, `marketplaces."${marketplace}"`]);
  let section = "";
  let sawPlugin = false;
  const config: CodexPluginConfig = { enabled: false };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;

    const name = kv[1];
    const value = parseTomlScalar(kv[2]);
    if (pluginSections.has(section) && name === "enabled") {
      sawPlugin = true;
      config.enabled = value === true;
    } else if (marketplaceSections.has(section) && name === "source_type" && typeof value === "string") {
      config.sourceType = value;
    } else if (marketplaceSections.has(section) && name === "source" && typeof value === "string") {
      config.source = value;
    }
  }

  return sawPlugin ? config : null;
}

function parseTomlScalar(rawValue: string): string | boolean {
  const value = rawValue.replace(/\s+#.*$/, "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  const quoted = value.match(/^"((?:\\"|[^"])*)"$/);
  if (quoted) return quoted[1].replace(/\\"/g, "\"");
  return value;
}
