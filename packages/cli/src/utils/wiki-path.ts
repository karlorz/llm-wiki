import { join } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";
import { parseDotenvFile, profileKey } from "./dotenv.js";

export type InitTimeSource = "flag" | "env" | "skillwiki-dotenv" | "hermes-dotenv" | "project-dotenv" | "default";
export type RuntimeSource = "flag" | "env" | "wiki-profile" | "wiki-default" | "skillwiki-dotenv" | "project-dotenv";

export interface ChainEntry { source: InitTimeSource; matched: boolean; value?: string }

export interface InitTimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  cwd?: string;
  explain?: boolean;
}
export interface InitTimePathResult {
  path: string;
  source: InitTimeSource;
  chain?: ChainEntry[];
}

export async function resolveInitTimePath(input: InitTimePathInput): Promise<InitTimePathResult> {
  const chain: ChainEntry[] = [];
  if (input.flag !== undefined && input.flag.length > 0) {
    if (input.explain) chain.push({ source: "flag", matched: true, value: input.flag });
    return { path: input.flag, source: "flag", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "flag", matched: false });

  if (input.envValue !== undefined && input.envValue.length > 0) {
    if (input.explain) chain.push({ source: "env", matched: true, value: input.envValue });
    return { path: input.envValue, source: "env", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "env", matched: false });

  const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (sw.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: true, value: sw.WIKI_PATH });
    return { path: sw.WIKI_PATH, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: false });

  const hermes = await parseDotenvFile(join(input.home, ".hermes", ".env"));
  if (hermes.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "hermes-dotenv", matched: true, value: hermes.WIKI_PATH });
    return { path: hermes.WIKI_PATH, source: "hermes-dotenv", ...(input.explain ? { chain } : {}) };
  }
  if (input.explain) chain.push({ source: "hermes-dotenv", matched: false });

  // Project-local ./skillwiki/.env
  if (input.cwd) {
    const projCfg = await parseDotenvFile(join(input.cwd, ".skillwiki", ".env"));
    if (projCfg.WIKI_PATH !== undefined) {
      if (input.explain) chain.push({ source: "project-dotenv", matched: true, value: projCfg.WIKI_PATH });
      return { path: projCfg.WIKI_PATH, source: "project-dotenv", ...(input.explain ? { chain } : {}) };
    }
  }
  if (input.explain) chain.push({ source: "project-dotenv", matched: false });

  const fallback = join(input.home, "wiki");
  if (input.explain) chain.push({ source: "default", matched: true, value: fallback });
  return { path: fallback, source: "default", ...(input.explain ? { chain } : {}) };
}

export interface RuntimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  wikiEnv?: string;  // $WIKI env var (profile name, distinct from $WIKI_PATH)
  home: string;
  wiki?: string;
  cwd?: string;
  explain?: boolean;
}
export interface RuntimePathOk {
  path: string;
  source: RuntimeSource;
  chain?: Array<{ source: RuntimeSource; matched: boolean; value?: string }>;
}

export async function resolveRuntimePath(input: RuntimePathInput): Promise<Result<RuntimePathOk>> {
  const chain: Array<{ source: RuntimeSource; matched: boolean; value?: string }> = [];

  // 1. --vault flag → absolute path, return immediately
  if (input.flag !== undefined && input.flag.length > 0) {
    if (input.explain) chain.push({ source: "flag", matched: true, value: input.flag });
    return ok({ path: input.flag, source: "flag", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "flag", matched: false });

  // Read global dotenv early for profile lookups
  const swGlobal = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));

  // 2. --wiki <name> → explicit profile
  const wikiName = input.wiki;
  if (wikiName !== undefined && wikiName.length > 0) {
    // "default" is an alias for the unnamed WIKI_PATH key
    if (wikiName.toLowerCase() === "default") {
      const path = swGlobal.WIKI_PATH;
      if (path !== undefined) {
        if (input.explain) chain.push({ source: "wiki-profile", matched: true, value: path });
        return ok({ path, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) });
      }
      if (input.explain) chain.push({ source: "wiki-profile", matched: false });
      return err("UNKNOWN_WIKI_PROFILE", {
        message: `Wiki profile "default" not found. Set it with: skillwiki config set wiki.path <dir>`
      });
    }
    const key = profileKey(wikiName, "PATH");
    const path = swGlobal[key];
    if (path !== undefined) {
      if (input.explain) chain.push({ source: "wiki-profile", matched: true, value: path });
      return ok({ path, source: "wiki-profile", ...(input.explain ? { chain } : {}) });
    }
    if (input.explain) chain.push({ source: "wiki-profile", matched: false });
    return err("UNKNOWN_WIKI_PROFILE", {
      message: `Wiki profile "${wikiName}" not found. Set it with: skillwiki config set wiki.${wikiName}.path <dir>`
    });
  }

  // 3. $WIKI env var → profile name lookup
  if (input.wikiEnv !== undefined && input.wikiEnv.length > 0) {
    const key = profileKey(input.wikiEnv, "PATH");
    const path = swGlobal[key];
    if (path !== undefined) {
      if (input.explain) chain.push({ source: "wiki-profile", matched: true, value: path });
      return ok({ path, source: "wiki-profile", ...(input.explain ? { chain } : {}) });
    }
    if (input.explain) chain.push({ source: "wiki-profile", matched: false });
    return err("UNKNOWN_WIKI_PROFILE", {
      message: `Wiki profile "${input.wikiEnv}" not found (from $WIKI env). Set it with: skillwiki config set wiki.${input.wikiEnv}.path <dir>`
    });
  }
  if (input.explain) chain.push({ source: "wiki-profile", matched: false });

  // 4. $WIKI_PATH env var → backward compat absolute path
  if (input.envValue !== undefined && input.envValue.length > 0) {
    if (input.explain) chain.push({ source: "env", matched: true, value: input.envValue });
    return ok({ path: input.envValue, source: "env", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "env", matched: false });

  // 5. Project-local ./skillwiki/.env
  if (input.cwd) {
    const projCfg = await parseDotenvFile(join(input.cwd, ".skillwiki", ".env"));
    if (projCfg.WIKI_PATH !== undefined) {
      if (input.explain) chain.push({ source: "project-dotenv", matched: true, value: projCfg.WIKI_PATH });
      return ok({ path: projCfg.WIKI_PATH, source: "project-dotenv", ...(input.explain ? { chain } : {}) });
    }
    if (input.explain) chain.push({ source: "project-dotenv", matched: false });
  }

  // 6. WIKI_DEFAULT → profile lookup
  const defaultProfile = swGlobal["WIKI_DEFAULT"];
  if (defaultProfile !== undefined) {
    const key = profileKey(defaultProfile, "PATH");
    const path = swGlobal[key];
    if (path !== undefined) {
      if (input.explain) chain.push({ source: "wiki-default", matched: true, value: path });
      return ok({ path, source: "wiki-default", ...(input.explain ? { chain } : {}) });
    }
    if (input.explain) chain.push({ source: "wiki-default", matched: false });
    return err("UNKNOWN_WIKI_PROFILE", {
      message: `Default wiki profile "${defaultProfile}" not found. Set it with: skillwiki config set wiki.${defaultProfile}.path <dir>`
    });
  }

  // 7. WIKI_PATH from global skillwiki-dotenv (backward compat)
  if (swGlobal.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: true, value: swGlobal.WIKI_PATH });
    return ok({ path: swGlobal.WIKI_PATH, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: false });

  // 8. Error
  return err("NO_VAULT_CONFIGURED", {
    message: "No vault configured. Run `skillwiki init` to bootstrap one, or pass `--vault <dir>`."
  });
}
