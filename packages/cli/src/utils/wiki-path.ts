import { join } from "node:path";
import { ok, err, type Result } from "@skillwiki/shared";
import { parseDotenvFile } from "./dotenv.js";

export type InitTimeSource = "flag" | "env" | "skillwiki-dotenv" | "hermes-dotenv" | "default";
export type RuntimeSource = "flag" | "env" | "skillwiki-dotenv";

export interface ChainEntry { source: InitTimeSource; matched: boolean; value?: string }

export interface InitTimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
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

  const fallback = join(input.home, "wiki");
  if (input.explain) chain.push({ source: "default", matched: true, value: fallback });
  return { path: fallback, source: "default", ...(input.explain ? { chain } : {}) };
}

export interface RuntimePathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  explain?: boolean;
}
export interface RuntimePathOk {
  path: string;
  source: RuntimeSource;
  chain?: Array<{ source: RuntimeSource; matched: boolean; value?: string }>;
}

export async function resolveRuntimePath(input: RuntimePathInput): Promise<Result<RuntimePathOk>> {
  const chain: Array<{ source: RuntimeSource; matched: boolean; value?: string }> = [];

  if (input.flag !== undefined && input.flag.length > 0) {
    if (input.explain) chain.push({ source: "flag", matched: true, value: input.flag });
    return ok({ path: input.flag, source: "flag", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "flag", matched: false });

  if (input.envValue !== undefined && input.envValue.length > 0) {
    if (input.explain) chain.push({ source: "env", matched: true, value: input.envValue });
    return ok({ path: input.envValue, source: "env", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "env", matched: false });

  const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (sw.WIKI_PATH !== undefined) {
    if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: true, value: sw.WIKI_PATH });
    return ok({ path: sw.WIKI_PATH, source: "skillwiki-dotenv", ...(input.explain ? { chain } : {}) });
  }
  if (input.explain) chain.push({ source: "skillwiki-dotenv", matched: false });

  return err("NO_VAULT_CONFIGURED", {
    message: "No vault configured. Run `skillwiki init` to bootstrap one, or pass `--vault <dir>`."
  });
}
