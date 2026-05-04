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
}

export async function runTopicMapCheck(
  input: TopicMapCheckInput
): Promise<{ exitCode: number; result: Result<TopicMapCheckOutput> }> {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const page_count = scan.data.typedKnowledge.length;
  return {
    exitCode: ExitCode.OK,
    result: ok({
      recommended: page_count >= threshold,
      page_count,
      threshold,
    }),
  };
}
