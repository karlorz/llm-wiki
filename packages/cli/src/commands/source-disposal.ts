import { ExitCode, ok, type Result } from "@skillwiki/shared";
import { applySourceDisposal, planSourceDisposal } from "../utils/source-disposal.js";

export interface SourceDisposalInput {
  vault: string;
  rawPath: string;
  reason: string;
  write?: boolean;
  approve?: string;
  attended?: boolean;
}

export async function runSourceDisposal(input: SourceDisposalInput): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceDisposal(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  if (!input.approve) return { exitCode: ExitCode.USAGE, result: { ok: false, error: "APPROVAL_INVALID", detail: { message: "--write requires --approve" } } };
  const applied = await applySourceDisposal({ ...input, approve: input.approve, attended: input.attended === true });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `permanently disposed ${input.rawPath}; ${applied.data.tombstone_path}` }) };
}
