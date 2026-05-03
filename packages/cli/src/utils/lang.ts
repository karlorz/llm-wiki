import { join } from "node:path";
import { parseDotenvFile } from "./dotenv.js";

export type LangSource = "flag" | "env" | "skillwiki-dotenv" | "default";

export interface LangResolution {
  value: string;       // raw input that was selected
  source: LangSource;
  canonical: string;   // normalized BCP 47-ish tag
}

const ALIASES: Record<string, string> = {
  english: "en",
  en: "en",
  "chinese-traditional": "zh-Hant",
  "zh-hant": "zh-Hant",
  "zh-tw": "zh-Hant",
  "chinese-simplified": "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-cn": "zh-Hans"
};

export function normalizeLang(input: string): string {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase();
  return ALIASES[key] ?? trimmed;
}

export interface ResolveLangInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
}

export async function resolveLang(input: ResolveLangInput): Promise<LangResolution> {
  if (input.flag !== undefined && input.flag.length > 0) {
    return { value: input.flag, source: "flag", canonical: normalizeLang(input.flag) };
  }
  if (input.envValue !== undefined && input.envValue.length > 0) {
    return { value: input.envValue, source: "env", canonical: normalizeLang(input.envValue) };
  }
  const dotenv = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
  if (dotenv.WIKI_LANG !== undefined) {
    return { value: dotenv.WIKI_LANG, source: "skillwiki-dotenv", canonical: normalizeLang(dotenv.WIKI_LANG) };
  }
  return { value: "en", source: "default", canonical: "en" };
}
