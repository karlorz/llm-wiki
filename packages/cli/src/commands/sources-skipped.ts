import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { readLogEvents, type SkillwikiLogEventV1 } from "../utils/log-events.js";

export interface SourceSkippedItem {
  operation_id: string;
  occurred_at: string;
  path: string;
  reason: string;
  stage: string;
  sha256?: string;
  host_id: string;
  actor: string;
}

export interface SourcesSkippedOutput {
  events: SourceSkippedItem[];
  humanHint: string;
}

export async function runSourcesSkipped(input: {
  vault: string;
}): Promise<{ exitCode: number; result: Result<SourcesSkippedOutput> }> {
  const eventsResult = await readLogEvents(input.vault);
  if (!eventsResult.ok) {
    return { exitCode: ExitCode.SCHEMA_NOT_DETECTED, result: eventsResult };
  }

  const skippedEvents = eventsResult.data.filter((e) => e.kind === "source-skipped");

  const items: SourceSkippedItem[] = skippedEvents.map((e) => {
    const meta = e.metadata ?? {};
    return {
      operation_id: e.operation_id,
      occurred_at: e.occurred_at,
      path: typeof meta.path === "string" ? meta.path : e.target,
      reason: typeof meta.reason === "string" ? meta.reason : e.note,
      stage: typeof meta.stage === "string" ? meta.stage : "inventory",
      ...(typeof meta.sha256 === "string" ? { sha256: meta.sha256 } : {}),
      host_id: e.host_id,
      actor: e.actor,
    };
  });

  // newest-first: readLogEvents returns oldest-first by occurred_at, so reverse it
  items.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at > b.occurred_at ? -1 : 1;
    return a.operation_id > b.operation_id ? -1 : a.operation_id < b.operation_id ? 1 : 0;
  });

  const humanHint = items.length === 0
    ? "no skipped sources"
    : items.map((item) => `${item.occurred_at.slice(0, 10)} ${item.stage} ${item.path} — ${item.reason}`).join("\n");

  return {
    exitCode: ExitCode.OK,
    result: ok({
      events: items,
      humanHint,
    }),
  };
}
