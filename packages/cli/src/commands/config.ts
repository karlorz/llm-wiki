import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDotenvFile, parseDotenvText, writeDotenv, type DotenvMap, CONFIG_KEYS, type ConfigKey, isValidWikiProfileKey } from "../utils/dotenv.js";

function validateKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key) || isValidWikiProfileKey(key);
}

export function configPath(home: string): string {
  return join(home, ".skillwiki", ".env");
}

export interface ConfigGetInput {
  key: string;
  home: string;
}
export interface ConfigGetOutput {
  key: string;
  value: string;
  humanHint: string;
}

export async function runConfigGet(
  input: ConfigGetInput
): Promise<{ exitCode: number; result: Result<ConfigGetOutput> }> {
  if (!validateKey(input.key)) {
    return { exitCode: ExitCode.INVALID_CONFIG_KEY, result: err("INVALID_CONFIG_KEY", { key: input.key }) };
  }
  const map = await parseDotenvFile(configPath(input.home));
  const value = map[input.key] ?? "";
  return { exitCode: ExitCode.OK, result: ok({ key: input.key, value, humanHint: value }) };
}

export interface ConfigSetInput {
  key: string;
  value: string;
  home: string;
}
export interface ConfigSetOutput {
  key: string;
  value: string;
  written: true;
  humanHint: string;
}

export async function runConfigSet(
  input: ConfigSetInput
): Promise<{ exitCode: number; result: Result<ConfigSetOutput> }> {
  if (!validateKey(input.key)) {
    return { exitCode: ExitCode.INVALID_CONFIG_KEY, result: err("INVALID_CONFIG_KEY", { key: input.key }) };
  }
  const filePath = configPath(input.home);
  try {
    let originalContent: string | undefined;
    try { originalContent = await readFile(filePath, "utf8"); } catch { /* file may not exist yet */ }
    const existing = originalContent !== undefined ? parseDotenvText(originalContent) : {};
    const merged: DotenvMap = { ...existing, [input.key]: input.value };
    await writeDotenv(filePath, merged, originalContent);
    return { exitCode: ExitCode.OK, result: ok({ key: input.key, value: input.value, written: true, humanHint: `${input.key}=${input.value}` }) };
  } catch (e: unknown) {
    return { exitCode: ExitCode.CONFIG_WRITE_FAILED, result: err("CONFIG_WRITE_FAILED", { key: input.key, error: String(e) }) };
  }
}

export interface ConfigListInput {
  home: string;
  profiles?: boolean;
}
export interface ConfigListOutput {
  entries: Array<{ key: string; value: string }>;
  profiles?: Array<{ name: string; path: string; isDefault: boolean }>;
  humanHint: string;
}

export async function runConfigList(
  input: ConfigListInput
): Promise<{ exitCode: number; result: Result<ConfigListOutput> }> {
  const map = await parseDotenvFile(configPath(input.home));
  const entries = Object.entries(map).map(([key, value]) => ({ key, value: value ?? "" }));

  let profiles: Array<{ name: string; path: string; isDefault: boolean }> | undefined;
  if (input.profiles) {
    const defaultProfile = map["WIKI_DEFAULT"];
    profiles = [];
    for (const key of Object.keys(map)) {
      const m = key.match(/^WIKI_([A-Z][A-Z0-9_]{0,31})_PATH$/);
      if (m && key !== "WIKI_PATH") {
        const name = m[1].toLowerCase().replace(/_/g, "-");
        profiles.push({ name, path: map[key] ?? "", isDefault: name === defaultProfile });
      }
    }
    profiles.sort((a, b) => a.name.localeCompare(b.name));
  }

  const hint = profiles
    ? profiles.map(p => `${p.isDefault ? "* " : "  "}${p.name} → ${p.path}`).join("\n") || "(no profiles)"
    : entries.map(e => `${e.key}=${e.value}`).join("\n");

  return { exitCode: ExitCode.OK, result: ok({ entries, profiles, humanHint: hint }) };
}

export interface ConfigPathInput {
  home: string;
}
export interface ConfigPathOutput {
  path: string;
  exists: boolean;
  humanHint: string;
}

export async function runConfigPath(
  input: ConfigPathInput
): Promise<{ exitCode: number; result: Result<ConfigPathOutput> }> {
  const filePath = configPath(input.home);
  return { exitCode: ExitCode.OK, result: ok({ path: filePath, exists: existsSync(filePath), humanHint: filePath }) };
}
