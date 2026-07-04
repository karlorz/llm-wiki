import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath, resolveRuntimePath } from "../utils/wiki-path.js";

export interface PathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  initTime: boolean;
  wiki?: string;
  explain?: boolean;
  cwd?: string;
}
export interface PathOutput {
  path: string;
  source: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
  humanHint: string;
}

export async function runPath(input: PathInput): Promise<{ exitCode: number; result: Result<PathOutput> }> {
  if (input.initTime) {
    const r = await resolveInitTimePath({
      flag: input.flag, envValue: input.envValue, home: input.home, cwd: input.cwd, explain: input.explain
    });
    return { exitCode: ExitCode.OK, result: ok({ path: r.path, source: r.source, ...(r.chain ? { chain: r.chain } : {}), humanHint: `${r.path} (via ${r.source})` }) };
  }
  const r = await resolveRuntimePath({
    flag: input.flag, envValue: input.envValue, home: input.home, wiki: input.wiki, cwd: input.cwd, explain: input.explain
  });
  if (!r.ok) {
    const exitCode = r.error === "UNKNOWN_WIKI_PROFILE" ? ExitCode.UNKNOWN_WIKI_PROFILE : ExitCode.NO_VAULT_CONFIGURED;
    return { exitCode, result: r };
  }
  return { exitCode: ExitCode.OK, result: ok({ path: r.data.path, source: r.data.source, ...(r.data.chain ? { chain: r.data.chain } : {}), humanHint: `${r.data.path} (via ${r.data.source})` }) };
}
