import { ExitCode, ok, type Result } from "@skillwiki/shared";
import { reindexPageInVectorIndex } from "../utils/vector-index.js";

export interface VectorsReindexPageInput {
  vault: string;
  page: string;
}

export interface VectorsReindexPageOutput {
  path: string;
  page: string;
  terms_added: number;
  terms_removed: number;
  page_count: number;
  humanHint: string;
}

export async function runVectorsReindexPage(
  input: VectorsReindexPageInput,
): Promise<{ exitCode: number; result: Result<VectorsReindexPageOutput> }> {
  const res = await reindexPageInVectorIndex(input.vault, input.page);
  if (!res.ok) {
    const exitCode =
      res.error === "FILE_NOT_FOUND"
        ? ExitCode.FILE_NOT_FOUND
        : ExitCode.USAGE;
    return { exitCode, result: res };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      path: res.data.path,
      page: res.data.page,
      terms_added: res.data.terms_added,
      terms_removed: res.data.terms_removed,
      page_count: res.data.page_count,
      humanHint: `reindexed ${res.data.page} (+${res.data.terms_added}/-${res.data.terms_removed} terms, ${res.data.page_count} pages total)`,
    }),
  };
}
