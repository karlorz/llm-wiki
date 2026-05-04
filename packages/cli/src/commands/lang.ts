import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveLang } from "../utils/lang.js";
import { parseDotenvFile } from "../utils/dotenv.js";
import { join } from "node:path";

export interface LangInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  explain?: boolean;
}
export interface LangOutput {
  value: string;
  source: "flag" | "env" | "skillwiki-dotenv" | "default";
  canonical: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
  humanHint: string;
}

export async function runLang(input: LangInput): Promise<{ exitCode: number; result: Result<LangOutput> }> {
  const resolved = await resolveLang({ flag: input.flag, envValue: input.envValue, home: input.home });
  let chain: Array<{ source: string; matched: boolean; value?: string }> | undefined;
  if (input.explain) {
    chain = [
      { source: "flag", matched: input.flag !== undefined && input.flag.length > 0, value: input.flag },
      { source: "env", matched: input.envValue !== undefined && input.envValue.length > 0, value: input.envValue }
    ];
    const sw = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
    chain.push({ source: "skillwiki-dotenv", matched: sw.WIKI_LANG !== undefined, value: sw.WIKI_LANG });
    chain.push({ source: "default", matched: resolved.source === "default", value: "en" });
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({
      value: resolved.value,
      source: resolved.source,
      canonical: resolved.canonical,
      ...(chain ? { chain } : {}),
      humanHint: `${resolved.value} (via ${resolved.source})`
    })
  };
}
