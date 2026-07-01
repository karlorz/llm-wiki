import { runMemoryTopics } from "../commands/memory.js";
import { runStale } from "../commands/stale.js";
import { ok, ExitCode, type Result } from "@skillwiki/shared";

export async function fetchMemoryTopicsSummary(input: {
  vault: string;
  project?: string;
  limit?: number;
}): Promise<{ exitCode: number; result: Result<unknown> }> {
  const r = await runMemoryTopics({
    vault: input.vault,
    project: input.project,
    limit: input.limit ?? 20,
  });
  return { exitCode: r.exitCode, result: r.result };
}

export async function fetchStaleSummary(input: {
  vault: string;
  days?: number;
  project?: string;
}): Promise<{ exitCode: number; result: Result<unknown> }> {
  const r = await runStale({
    vault: input.vault,
    days: input.days ?? 90,
    archive: false,
    project: input.project,
  });
  if (!r.result.ok) return { exitCode: r.exitCode, result: r.result };
  const d = r.result.data;
  return {
    exitCode: r.exitCode,
    result: ok({
      stale_transcript_count: d.stale_transcripts?.length ?? 0,
      unclaimed_transcript_count: d.unclaimed_transcripts?.length ?? 0,
      incomplete_work_item_count: d.incomplete_work_items?.length ?? 0,
      done_work_item_count: d.done_work_items?.length ?? 0,
      sample_stale: (d.stale_transcripts ?? []).slice(0, 5).map((x) => x.path),
      sample_incomplete: (d.incomplete_work_items ?? []).slice(0, 5).map((x) => x.path),
      humanHint: d.humanHint,
    }),
  };
}