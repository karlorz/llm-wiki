import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseDotenvFile, writeDotenv, type DotenvMap } from "../utils/dotenv.js";

type ConfigKey = "WIKI_PATH" | "WIKI_LANG";

function validateKey(key: string): key is ConfigKey {
  return key === "WIKI_PATH" || key === "WIKI_LANG";
}

function configPath(home: string): string {
  return join(home, ".skillwiki", ".env");
}

// ── runConfigGet ──────────────────────────────────────────────

export interface ConfigGetInput {
  key: string;
  home: string;
}
export interface ConfigGetOutput {
  key: string;
  value: string;
}

export async function runConfigGet(
  input: ConfigGetInput
): Promise<{ exitCode: number; result: Result<ConfigGetOutput> }> {
  if (!validateKey(input.key)) {
    return { exitCode: ExitCode.INVALID_CONFIG_KEY, result: err("INVALID_CONFIG_KEY", { key: input.key }) };
  }
  const map = await parseDotenvFile(configPath(input.home));
  const value = map[input.key] ?? "";
  return { exitCode: ExitCode.OK, result: ok({ key: input.key, value }) };
}

// ── runConfigSet ──────────────────────────────────────────────

export interface ConfigSetInput {
  key: string;
  value: string;
  home: string;
}
export interface ConfigSetOutput {
  key: string;
  value: string;
  written: true;
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
    const existing = originalContent !== undefined ? await parseDotenvFile(filePath) : {};
    const merged: DotenvMap = { ...existing, [input.key]: input.value };
    await writeDotenv(filePath, merged, originalContent);
    return { exitCode: ExitCode.OK, result: ok({ key: input.key, value: input.value, written: true }) };
  } catch (e) {
    return { exitCode: ExitCode.CONFIG_WRITE_FAILED, result: err("CONFIG_WRITE_FAILED", { key: input.key, error: String(e) }) };
  }
}

// ── runConfigList ─────────────────────────────────────────────

export interface ConfigListInput {
  home: string;
}
export interface ConfigListOutput {
  entries: Array<{ key: string; value: string }>;
}

export async function runConfigList(
  input: ConfigListInput
): Promise<{ exitCode: number; result: Result<ConfigListOutput> }> {
  const map = await parseDotenvFile(configPath(input.home));
  const entries = Object.entries(map).map(([key, value]) => ({ key, value: value ?? "" }));
  return { exitCode: ExitCode.OK, result: ok({ entries }) };
}

// ── runConfigPath ─────────────────────────────────────────────

export interface ConfigPathInput {
  home: string;
}
export interface ConfigPathOutput {
  path: string;
  exists: boolean;
}

export async function runConfigPath(
  input: ConfigPathInput
): Promise<{ exitCode: number; result: Result<ConfigPathOutput> }> {
  const path = configPath(input.home);
  return { exitCode: ExitCode.OK, result: ok({ path, exists: existsSync(path) }) };
}
