import { ExitCode, ok, type Result } from "@skillwiki/shared";
import { pruneVectorIndex } from "../utils/vector-index.js";

export interface VectorsPrunePageInput {
  vault: string;
  dryRun?: boolean;
}

export interface VectorsPrunePageOutput {
  path: string;
  orphans: string[];
  removed: number;
  page_count: number;
  terms_pruned: number;
  dry_run: boolean;
  humanHint: string;
}

export async function runVectorsPrunePage(
  input: VectorsPrunePageInput,
): Promise<{ exitCode: number; result: Result<VectorsPrunePageOutput> }> {
  const isDryRun = !!input.dryRun;
  const res = await pruneVectorIndex(input.vault, { dryRun: isDryRun });
  if (!res.ok) {
    return { exitCode: ExitCode.USAGE, result: res };
  }

  const { path, orphans, removed, page_count, terms_pruned } = res.data;
  let humanHint: string;
  if (removed === 0) {
    humanHint = "no orphan pages found in vector cache";
  } else if (isDryRun) {
    humanHint = `dry run: would prune ${removed} orphan ${removed === 1 ? "page" : "pages"} (${page_count} pages remaining)`;
  } else {
    humanHint = `pruned ${removed} orphan ${removed === 1 ? "page" : "pages"} (${terms_pruned} terms pruned, ${page_count} pages total)`;
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      path,
      orphans,
      removed,
      page_count,
      terms_pruned,
      dry_run: isDryRun,
      humanHint,
    }),
  };
}
