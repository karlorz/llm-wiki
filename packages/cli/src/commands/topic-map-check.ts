import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";

const DEFAULT_THRESHOLD = 200;

export interface TopicMapCheckInput {
  vault: string;
  threshold?: number;
}

export interface TopicMapCheckOutput {
  recommended: boolean;
  page_count: number;
  threshold: number;
  humanHint: string;
}

export async function runTopicMapCheck(
  input: TopicMapCheckInput
): Promise<{ exitCode: number; result: Result<TopicMapCheckOutput> }> {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const page_count = scan.data.typedKnowledge.length;
  const recommended = page_count >= threshold;
  return {
    exitCode: ExitCode.OK,
    result: ok({
      recommended,
      page_count,
      threshold,
      humanHint: recommended
        ? `topic map recommended (${page_count} pages >= ${threshold} threshold)`
        : `topic map not needed (${page_count} pages < ${threshold} threshold)`,
    }),
  };
}
