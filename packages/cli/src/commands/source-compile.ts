import { ExitCode, ok, type Result } from "@skillwiki/shared";
import {
  applySourceCompileClaim,
  applySourceCompilePublished,
  applySourceCompileRelease,
  applySourceReview,
  listCompileStatus,
  listSourceReviews,
  planSourceCompileClaim,
  planSourceCompilePublished,
  planSourceCompileRelease,
  planSourceReview,
  type ReviewStatus,
  type SessionKindName,
} from "../utils/source-compile.js";

export interface SourceCompileMutateInput {
  vault: string;
  rawPath: string;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  write?: boolean;
  approve?: string;
}

function writeGuard(approve: string | undefined): Result<never> | null {
  if (!approve) return { ok: false, error: "APPROVAL_INVALID", detail: { message: "--write requires --approve" } };
  return null;
}

export async function runSourceCompileClaim(input: SourceCompileMutateInput): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceCompileClaim(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  const missing = writeGuard(input.approve);
  if (missing) return { exitCode: ExitCode.USAGE, result: missing };
  const applied = await applySourceCompileClaim({ ...input, approve: input.approve! });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `claimed ${input.rawPath}` }) };
}

export async function runSourceCompileRelease(input: SourceCompileMutateInput): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceCompileRelease(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  const missing = writeGuard(input.approve);
  if (missing) return { exitCode: ExitCode.USAGE, result: missing };
  const applied = await applySourceCompileRelease({ ...input, approve: input.approve! });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `released ${input.rawPath}` }) };
}

export async function runSourceCompilePublished(input: SourceCompileMutateInput & { pages: string[] }): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceCompilePublished(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  const missing = writeGuard(input.approve);
  if (missing) return { exitCode: ExitCode.USAGE, result: missing };
  const applied = await applySourceCompilePublished({ ...input, approve: input.approve! });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `published compile turn for ${input.rawPath}` }) };
}

export async function runSourceReview(input: SourceCompileMutateInput & { status: ReviewStatus }): Promise<{ exitCode: number; result: Result<unknown> }> {
  if (!input.write) {
    const plan = await planSourceReview(input);
    return { exitCode: plan.ok ? ExitCode.OK : ExitCode.USAGE, result: plan };
  }
  const missing = writeGuard(input.approve);
  if (missing) return { exitCode: ExitCode.USAGE, result: missing };
  const applied = await applySourceReview({ ...input, approve: input.approve! });
  if (!applied.ok) return { exitCode: ExitCode.USAGE, result: applied };
  return { exitCode: ExitCode.OK, result: ok({ ...applied.data, humanHint: `${input.status} review for ${input.rawPath}` }) };
}

export async function runSourceCompileStatus(input: { vault: string; now?: string }): Promise<{ exitCode: number; result: Result<unknown> }> {
  const listed = await listCompileStatus(input);
  if (!listed.ok) return { exitCode: ExitCode.USAGE, result: listed };
  return { exitCode: ExitCode.OK, result: ok({ ...listed.data, humanHint: listed.data.items.length ? `${listed.data.items.length} compile turns` : "no active compile turns" }) };
}

export async function runSourceReviews(input: { vault: string; now?: string }): Promise<{ exitCode: number; result: Result<unknown> }> {
  const listed = await listSourceReviews(input);
  if (!listed.ok) return { exitCode: ExitCode.USAGE, result: listed };
  return { exitCode: ExitCode.OK, result: ok({ ...listed.data, humanHint: listed.data.items.length ? `${listed.data.items.length} open reviews` : "no open reviews" }) };
}
