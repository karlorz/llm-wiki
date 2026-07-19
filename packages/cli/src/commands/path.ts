import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath, resolveRuntimePath } from "../utils/wiki-path.js";

export interface PathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  initTime: boolean;
  wiki?: string;
  explain?: boolean;
  /** When true, callers should print only the path string (no JSON wrapper). */
  plain?: boolean;
  cwd?: string;
}
export interface PathOutput {
  path: string;
  source: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
  plain?: boolean;
  humanHint: string;
}

function toPathOutput(
  path: string,
  source: string,
  plain: boolean | undefined,
  chain?: Array<{ source: string; matched: boolean; value?: string }>,
): PathOutput {
  return {
    path,
    source,
    ...(chain ? { chain } : {}),
    ...(plain ? { plain: true } : {}),
    humanHint: plain ? path : `${path} (via ${source})`,
  };
}

export async function runPath(input: PathInput): Promise<{ exitCode: number; result: Result<PathOutput> }> {
  if (input.initTime) {
    const r = await resolveInitTimePath({
      flag: input.flag,
      envValue: input.envValue,
      home: input.home,
      cwd: input.cwd,
      explain: input.explain,
    });
    return {
      exitCode: ExitCode.OK,
      result: ok(toPathOutput(r.path, r.source, input.plain, r.chain)),
    };
  }
  const r = await resolveRuntimePath({
    flag: input.flag,
    envValue: input.envValue,
    home: input.home,
    wiki: input.wiki,
    cwd: input.cwd,
    explain: input.explain,
  });
  if (!r.ok) {
    const exitCode = r.error === "UNKNOWN_WIKI_PROFILE" ? ExitCode.UNKNOWN_WIKI_PROFILE : ExitCode.NO_VAULT_CONFIGURED;
    return { exitCode, result: r };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok(toPathOutput(r.data.path, r.data.source, input.plain, r.data.chain)),
  };
}
