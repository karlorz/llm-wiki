import { runQuery } from "../commands/query.js";
import { ok, ExitCode, type Result } from "@skillwiki/shared";

export interface QueryPreviewInput {
  vault: string;
  text: string;
  offset?: number;
  limit?: number;
}

export interface QueryPreviewOutput {
  text: string;
  total: number;
  offset: number;
  limit: number;
  results: Array<{ path: string; score: number; title: string; type: string }>;
  truncated: boolean;
}

export async function fetchQueryPreview(
  input: QueryPreviewInput,
): Promise<{ exitCode: number; result: Result<QueryPreviewOutput> }> {
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 10), 50);
  const fetchLimit = Math.min(offset + limit, 100);

  const r = await runQuery({ vault: input.vault, text: input.text, limit: fetchLimit });
  if (!r.result.ok) return { exitCode: r.exitCode, result: r.result };

  const all = r.result.data.results;
  const page = all.slice(offset, offset + limit);

  return {
    exitCode: ExitCode.OK,
    result: ok({
      text: input.text,
      total: all.length,
      offset,
      limit,
      results: page,
      truncated: page.length < all.length || all.length >= fetchLimit,
    }),
  };
}