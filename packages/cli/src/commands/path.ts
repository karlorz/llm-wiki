import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveInitTimePath, resolveRuntimePath } from "../utils/wiki-path.js";

export interface PathInput {
  flag: string | undefined;
  envValue: string | undefined;
  home: string;
  initTime: boolean;
  explain?: boolean;
}
export interface PathOutput {
  path: string;
  source: string;
  chain?: Array<{ source: string; matched: boolean; value?: string }>;
}

export async function runPath(input: PathInput): Promise<{ exitCode: number; result: Result<PathOutput> }> {
  if (input.initTime) {
    const r = await resolveInitTimePath({
      flag: input.flag, envValue: input.envValue, home: input.home, explain: input.explain
    });
    return { exitCode: ExitCode.OK, result: ok({ path: r.path, source: r.source, ...(r.chain ? { chain: r.chain } : {}) }) };
  }
  const r = await resolveRuntimePath({
    flag: input.flag, envValue: input.envValue, home: input.home, explain: input.explain
  });
  if (!r.ok) return { exitCode: ExitCode.NO_VAULT_CONFIGURED, result: r };
  return { exitCode: ExitCode.OK, result: ok({ path: r.data.path, source: r.data.source, ...(r.data.chain ? { chain: r.data.chain } : {}) }) };
}
