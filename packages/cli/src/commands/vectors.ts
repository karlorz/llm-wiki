import { ExitCode, ok, type Result } from "@skillwiki/shared";
import { buildVectorIndex, vectorIndexStatus } from "../utils/vector-index.js";

export async function runVectorsRebuild(input: { vault: string }): Promise<{ exitCode: number; result: Result<unknown> }> {
  const built = await buildVectorIndex(input.vault);
  if (!built.ok) return { exitCode: ExitCode.USAGE, result: built };
  return {
    exitCode: ExitCode.OK,
    result: ok({
      path: ".skillwiki/vectors/index.json",
      page_count: built.data.page_count,
      built_at: built.data.built_at,
      humanHint: `indexed ${built.data.page_count} pages`,
    }),
  };
}

export async function runVectorsStatus(input: { vault: string }): Promise<{ exitCode: number; result: Result<unknown> }> {
  const status = await vectorIndexStatus(input.vault);
  if (!status.ok) return { exitCode: ExitCode.USAGE, result: status };
  return {
    exitCode: ExitCode.OK,
    result: ok({
      ...status.data,
      humanHint: status.data.present ? `vector cache present (${status.data.page_count} pages)` : "no vector cache; run skillwiki vectors rebuild",
    }),
  };
}
