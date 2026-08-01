import { ExitCode, ok, type Result } from "@skillwiki/shared";
import { applySourceDisposition, planSourceDisposition, type SourceDispositionStatus } from "../utils/source-dispositions.js";

export interface SourceDispositionInput {
  vault: string;
  rawPath: string;
  status: SourceDispositionStatus;
  reason: string;
  reviewAfter?: string;
  duplicateOf?: string;
  write?: boolean;
  approve?: string;
}

export async function runSourceDisposition(input: SourceDispositionInput): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceDisposition(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  if (!input.approve) return { exitCode: ExitCode.USAGE, result: { ok: false, error: "APPROVAL_INVALID", detail: { message: "--write requires --approve" } } };
  const applied = await applySourceDisposition({ ...input, approve: input.approve });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `${input.status} recorded for ${input.rawPath}` }) };
}
