import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const REGISTRY_PATH = join(".claude", "plugins", "installed_plugins.json");
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
