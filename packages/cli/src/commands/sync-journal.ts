import { ok, ExitCode, type Result } from "@skillwiki/shared";
import {
  listJournalOpIds,
  listReviewRequiredOps,
  readJournal,
  supersedeStaleReviewRequiredJournals,
  type JournalFields,
} from "../utils/operation-journal.js";

export interface SyncJournalListInput {
  vault: string;
}

export interface SyncJournalListOutput {
  total: number;
  by_phase: Record<string, number>;
  review_required: Array<{
    operation_id: string;
    reason?: string;
    target_oid?: string;
    original_head?: string;
  }>;
  humanHint: string;
}

export interface SyncJournalClearStaleInput {
  vault: string;
  dryRun?: boolean;
}

export interface SyncJournalClearStaleOutput {
  dry_run: boolean;
  superseded: string[];
  skipped: string[];
  humanHint: string;
}

export function runSyncJournalList(
  input: SyncJournalListInput,
): { exitCode: number; result: Result<SyncJournalListOutput> } {
  const byPhase: Record<string, number> = {};
  for (const opId of listJournalOpIds(input.vault)) {
    const fields = readJournal(input.vault, opId) as JournalFields | null;
    const phase = fields?.phase ?? "unknown";
    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
  }
  const review = listReviewRequiredOps(input.vault).map(({ opId, fields }) => ({
    operation_id: opId,
    reason: fields.reason,
    target_oid: fields.target_oid,
    original_head: fields.original_head,
  }));
  const total = Object.values(byPhase).reduce((a, b) => a + b, 0);
  const hint =
    review.length === 0
      ? `journals: ${total} total; no review-required handoffs`
      : `journals: ${total} total; ${review.length} review-required — if worktree clean: skillwiki sync journal clear-stale --dry-run`;
  return {
    exitCode: ExitCode.OK,
    result: ok({
      total,
      by_phase: byPhase,
      review_required: review,
      humanHint: hint,
    }),
  };
}

export function runSyncJournalClearStale(
  input: SyncJournalClearStaleInput,
): { exitCode: number; result: Result<SyncJournalClearStaleOutput> } {
  const { superseded, skipped } = supersedeStaleReviewRequiredJournals(input.vault, {
    dryRun: !!input.dryRun,
    by: input.dryRun ? "skillwiki-sync-journal-clear-stale-dry-run" : "skillwiki-sync-journal-clear-stale",
  });
  const mode = input.dryRun ? "dry-run" : "write";
  const hint =
    superseded.length === 0
      ? `clear-stale (${mode}): nothing to supersede; skipped=${skipped.length}`
      : `clear-stale (${mode}): ${superseded.length} journal(s); skipped=${skipped.length}`;
  return {
    exitCode: ExitCode.OK,
    result: ok({
      dry_run: !!input.dryRun,
      superseded,
      skipped,
      humanHint: hint,
    }),
  };
}
