import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "@skillwiki/shared";
import { splitFrontmatter } from "../parsers/frontmatter.js";
import { readLogEvents, writeLogEvent, type SkillwikiLogEventV1 } from "./log-events.js";
import { operationId } from "./operation-id.js";
import { classifyRawPath } from "./raw-operation-policy.js";
import { decodeSourceActionApproval, encodeSourceActionApproval } from "./source-action-approval.js";
import { scanSensitiveContent } from "./sensitive-content.js";
import { resolveExistingRegularFileInsideVault } from "./vault-path-safety.js";

export type SourceDispositionStatus = "reviewed-no-op" | "deferred" | "duplicate" | "out-of-scope" | "superseded" | "reopened";

export interface SourceDisposition {
  operation_id: string;
  occurred_at: string;
  raw_path: string;
  complete_sha256?: string;
  body_sha256?: string;
  status: SourceDispositionStatus;
  reason: string;
  review_after?: string;
  duplicate_of?: string;
}

export interface SourceDispositionPlan extends SourceDisposition {
  complete_sha256: string;
  approval_token: string;
  write: false;
}

const STATUSES = new Set<SourceDispositionStatus>(["reviewed-no-op", "deferred", "duplicate", "out-of-scope", "superseded", "reopened"]);

export function bodySha256(text: string): string {
  const split = splitFrontmatter(text);
  const body = split.ok ? split.data.body : text;
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

export function completeSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function exactActiveSource(path: string): Result<true> {
  const parsed = classifyRawPath(path);
  if (!parsed.ok) return parsed;
  if (parsed.data.storage !== "active" || !(["articles", "papers"] as const).includes(parsed.data.category as "articles" | "papers")) {
    return err("SOURCE_DISPOSITION_TARGET_INVALID", { path, message: "dispositions require an exact active raw article or paper" });
  }
  return ok(true);
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function parseSourceDispositionEvent(event: SkillwikiLogEventV1): Result<SourceDisposition | null> {
  if (event.kind !== "source-disposition") return ok(null);
  const metadata = event.metadata;
  if (!STATUSES.has(metadata.status as SourceDispositionStatus)
    || typeof metadata.raw_path !== "string"
    || (typeof metadata.complete_sha256 !== "string" && typeof metadata.body_sha256 !== "string")
    || (typeof metadata.complete_sha256 === "string" && !/^[0-9a-f]{64}$/.test(metadata.complete_sha256))
    || (typeof metadata.body_sha256 === "string" && !/^[0-9a-f]{64}$/.test(metadata.body_sha256))
    || typeof metadata.reason !== "string") {
    return err("SOURCE_DISPOSITION_INVALID", { operation_id: event.operation_id });
  }
  return ok({
    operation_id: event.operation_id,
    occurred_at: event.occurred_at,
    raw_path: metadata.raw_path,
    ...(typeof metadata.complete_sha256 === "string" ? { complete_sha256: metadata.complete_sha256 } : {}),
    ...(typeof metadata.body_sha256 === "string" ? { body_sha256: metadata.body_sha256 } : {}),
    status: metadata.status as SourceDispositionStatus,
    reason: metadata.reason,
    ...(typeof metadata.review_after === "string" ? { review_after: metadata.review_after } : {}),
    ...(typeof metadata.duplicate_of === "string" ? { duplicate_of: metadata.duplicate_of } : {}),
  });
}

export function projectSourceDispositions(events: readonly SkillwikiLogEventV1[]): Result<SourceDisposition[]> {
  const dispositions: SourceDisposition[] = [];
  for (const event of events) {
    const parsed = parseSourceDispositionEvent(event);
    if (!parsed.ok) return parsed;
    if (parsed.data) dispositions.push(parsed.data);
  }
  return ok(dispositions.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.operation_id.localeCompare(b.operation_id)));
}

export async function readSourceDispositions(vault: string): Promise<Result<SourceDisposition[]>> {
  const events = await readLogEvents(vault);
  if (!events.ok) return events;
  return projectSourceDispositions(events.data);
}

export function effectiveSourceDisposition(input: {
  dispositions: readonly SourceDisposition[];
  rawPath: string;
  bodySha256: string;
  completeSha256: string;
  today: string;
}): { disposition?: SourceDisposition; lifecycle: "pending" | "deferred" | "reviewed-no-op" | "duplicate" | "out-of-scope" | "superseded"; identityMismatch: boolean } {
  const candidates = input.dispositions.filter(event => event.raw_path === input.rawPath);
  const latest = candidates.at(-1);
  if (!latest) return { lifecycle: "pending", identityMismatch: false };
  const identityMatches = latest.complete_sha256
    ? latest.complete_sha256 === input.completeSha256
    : latest.body_sha256 === input.bodySha256;
  if (!identityMatches) return { lifecycle: "pending", identityMismatch: true, disposition: latest };
  if (latest.status === "reopened") return { lifecycle: "pending", identityMismatch: false, disposition: latest };
  if (latest.status === "deferred") {
    return latest.review_after && latest.review_after > input.today
      ? { lifecycle: "deferred", identityMismatch: false, disposition: latest }
      : { lifecycle: "pending", identityMismatch: false, disposition: latest };
  }
  return { lifecycle: latest.status, identityMismatch: false, disposition: latest };
}

function latestDuplicateTarget(dispositions: readonly SourceDisposition[], rawPath: string): string | undefined {
  const latest = dispositions.filter(event => event.raw_path === rawPath).at(-1);
  return latest?.status === "duplicate" ? latest.duplicate_of : undefined;
}

export async function planSourceDisposition(input: {
  vault: string;
  rawPath: string;
  status: SourceDispositionStatus;
  reason: string;
  reviewAfter?: string;
  duplicateOf?: string;
  now?: string;
  today?: string;
}): Promise<Result<SourceDispositionPlan>> {
  const target = exactActiveSource(input.rawPath);
  if (!target.ok) return target;
  if (!STATUSES.has(input.status)) return err("SOURCE_DISPOSITION_INVALID", { field: "status" });
  const reason = input.reason.normalize("NFC").trim();
  if (!reason) return err("SOURCE_DISPOSITION_INVALID", { field: "reason", message: "reason is required" });
  const sensitive = scanSensitiveContent(reason);
  if (sensitive.length > 0) return err("SENSITIVE_CONTENT_DETECTED", { findings: sensitive });
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (input.status === "deferred" && (!input.reviewAfter || !validDate(input.reviewAfter) || input.reviewAfter <= today)) {
    return err("SOURCE_DISPOSITION_INVALID", { field: "review_after", message: "deferred requires a future YYYY-MM-DD" });
  }
  if (input.status === "duplicate") {
    if (!input.duplicateOf || input.duplicateOf === input.rawPath) return err("SOURCE_DISPOSITION_INVALID", { field: "duplicate_of" });
    const duplicateTarget = exactActiveSource(input.duplicateOf);
    if (!duplicateTarget.ok) return duplicateTarget;
    const duplicateResolved = await resolveExistingRegularFileInsideVault(input.vault, input.duplicateOf);
    if (!duplicateResolved.ok) return err("SOURCE_DISPOSITION_INVALID", { field: "duplicate_of", message: "canonical duplicate target not found", cause: duplicateResolved });
  }
  const sourceResolved = await resolveExistingRegularFileInsideVault(input.vault, input.rawPath);
  if (!sourceResolved.ok) return err("FILE_NOT_FOUND", { path: input.rawPath, cause: sourceResolved });
  const text = await readFile(sourceResolved.data, "utf8");
  const bodyHash = bodySha256(text);
  const completeHash = completeSha256(text);
  const existing = await readSourceDispositions(input.vault);
  if (!existing.ok) return existing;
  if (input.status === "duplicate" && input.duplicateOf) {
    const seen = new Set([input.rawPath]);
    let current: string | undefined = input.duplicateOf;
    while (current) {
      if (seen.has(current)) {
        return err("SOURCE_DISPOSITION_INVALID", {
          field: "duplicate_of",
          message: "duplicate dispositions may not create a direct or transitive cycle",
        });
      }
      seen.add(current);
      current = latestDuplicateTarget(existing.data, current);
    }
  }
  if (input.status === "reopened") {
    const effective = effectiveSourceDisposition({ dispositions: existing.data, rawPath: input.rawPath, bodySha256: bodyHash, completeSha256: completeHash, today });
    if (!effective.disposition || effective.lifecycle === "pending") return err("SOURCE_DISPOSITION_INVALID", { field: "status", message: "reopened requires an effective prior disposition" });
  }
  const occurredAt = input.now ?? new Date().toISOString();
  const operation_id = operationId("source-disposition", [input.rawPath, completeHash, input.status, reason, input.reviewAfter ?? "", input.duplicateOf ?? ""]);
  const base = {
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: completeHash,
    status: input.status,
    reason,
    ...(input.reviewAfter ? { review_after: input.reviewAfter } : {}),
    ...(input.duplicateOf ? { duplicate_of: input.duplicateOf } : {}),
  };
  return ok({ ...base, approval_token: encodeSourceActionApproval({ contract: "source-disposition/v1", ...base }), write: false });
}

export async function applySourceDisposition(input: {
  vault: string;
  approve: string;
  rawPath: string;
  status: SourceDispositionStatus;
  reason: string;
  reviewAfter?: string;
  duplicateOf?: string;
  actor?: string;
  hostId?: string;
  today?: string;
}): Promise<Result<{ event_path: string; operation_id: string; created: boolean }>> {
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceDisposition({ ...input, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source disposition approval does not match live state" });
  const event = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-disposition",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      status: input.status,
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      reason: planned.data.reason,
      ...(input.reviewAfter ? { review_after: input.reviewAfter } : {}),
      ...(input.duplicateOf ? { duplicate_of: input.duplicateOf } : {}),
    },
  });
  if (!event.ok) return event;
  return ok({ event_path: event.data.path, operation_id: planned.data.operation_id, created: event.data.created });
}
