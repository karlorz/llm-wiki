import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "@skillwiki/shared";
import { completeSha256 } from "./source-dispositions.js";
import { classifyRawPath } from "./raw-operation-policy.js";
import { resolveExistingRegularFileInsideVault } from "./vault-path-safety.js";
import { readLogEvents, writeLogEvent, type SkillwikiLogEventV1 } from "./log-events.js";
import { operationId } from "./operation-id.js";
import { decodeSourceActionApproval, encodeSourceActionApproval } from "./source-action-approval.js";
import { scanSensitiveContent } from "./sensitive-content.js";
import { inventorySources } from "./source-lifecycle.js";

export const COMPILE_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
export const TYPED_PAGE_PATH = /^(entities|concepts|comparisons|queries)\/.+\.md$/;

export type CompileEventKind =
  | "source-compile-claimed"
  | "source-compile-released"
  | "source-compile-published"
  | "source-review";

export type ReviewStatus = "open" | "accepted" | "needs-fix" | "dismissed";
export type CompileProjectionStatus = "none" | "compiling" | "review-open" | "review-closed";
export type SessionKindName = "interactive" | "headless" | "goal" | "satellite";

export interface SourceCompileEvent {
  kind: CompileEventKind;
  operation_id: string;
  occurred_at: string;
  host_id: string;
  actor: string;
  raw_path: string;
  reason?: string;
  complete_sha256?: string;
  expires_at?: string;
  session_kind?: string;
  turn_id?: string;
  typed_paths?: string[];
  status?: ReviewStatus;
}

export interface CompileState {
  status: CompileProjectionStatus;
  identityMismatch: boolean;
  claim?: SourceCompileEvent;
  published?: SourceCompileEvent;
  review?: SourceCompileEvent;
}

export interface SourceCompilePlan {
  operation_id: string;
  occurred_at: string;
  raw_path: string;
  complete_sha256: string;
  approval_token: string;
  write: false;
  expires_at?: string;
  turn_id?: string;
  typed_paths?: string[];
  status?: ReviewStatus;
  review_operation_id?: string;
}

const KINDS = new Set<CompileEventKind>([
  "source-compile-claimed",
  "source-compile-released",
  "source-compile-published",
  "source-review",
]);
const REVIEW_STATUSES = new Set<ReviewStatus>(["open", "accepted", "needs-fix", "dismissed"]);

function shaField(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function exactActiveArticleOrPaper(path: string): Result<true> {
  const parsed = classifyRawPath(path);
  if (!parsed.ok) return parsed;
  if (parsed.data.storage !== "active" || (parsed.data.category !== "articles" && parsed.data.category !== "papers")) {
    return err("SOURCE_COMPILE_TARGET_INVALID", { path, message: "compile turns require an exact active raw article or paper" });
  }
  return ok(true);
}

function requireInteractive(sessionKind: SessionKindName | undefined): Result<true> {
  if (sessionKind !== "interactive") {
    return err("SOURCE_COMPILE_SESSION_KIND", { session_kind: sessionKind ?? "unknown", message: "mutating compile/review commands require an interactive session" });
  }
  return ok(true);
}

function requireReason(reason: string): Result<string> {
  const trimmed = reason.normalize("NFC").trim();
  if (!trimmed) return err("SOURCE_COMPILE_INVALID", { field: "reason", message: "reason is required" });
  const sensitive = scanSensitiveContent(trimmed);
  if (sensitive.length > 0) return err("SENSITIVE_CONTENT_DETECTED", { findings: sensitive });
  return ok(trimmed);
}

export function parseSourceCompileEvent(event: SkillwikiLogEventV1): Result<SourceCompileEvent | null> {
  if (!KINDS.has(event.kind as CompileEventKind)) return ok(null);
  const metadata = event.metadata;
  if (typeof metadata.raw_path !== "string") return err("SOURCE_COMPILE_INVALID", { operation_id: event.operation_id });
  if (event.kind === "source-compile-claimed") {
    if (!shaField(metadata.complete_sha256) || typeof metadata.expires_at !== "string" || !shaField(metadata.turn_id) || typeof metadata.reason !== "string") {
      return err("SOURCE_COMPILE_INVALID", { operation_id: event.operation_id });
    }
  }
  if (event.kind === "source-compile-released" && (typeof metadata.reason !== "string" || (metadata.complete_sha256 !== undefined && !shaField(metadata.complete_sha256)))) {
    return err("SOURCE_COMPILE_INVALID", { operation_id: event.operation_id });
  }
  if (event.kind === "source-compile-published") {
    if (!shaField(metadata.complete_sha256) || !shaField(metadata.turn_id) || !Array.isArray(metadata.typed_paths) || metadata.typed_paths.length === 0) {
      return err("SOURCE_COMPILE_INVALID", { operation_id: event.operation_id });
    }
  }
  if (event.kind === "source-review") {
    if (!shaField(metadata.turn_id) || !REVIEW_STATUSES.has(metadata.status as ReviewStatus) || typeof metadata.reason !== "string") {
      return err("SOURCE_COMPILE_INVALID", { operation_id: event.operation_id });
    }
  }
  return ok({
    kind: event.kind as CompileEventKind,
    operation_id: event.operation_id,
    occurred_at: event.occurred_at,
    host_id: event.host_id,
    actor: event.actor,
    raw_path: metadata.raw_path,
    ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}),
    ...(shaField(metadata.complete_sha256) ? { complete_sha256: metadata.complete_sha256 } : {}),
    ...(typeof metadata.expires_at === "string" ? { expires_at: metadata.expires_at } : {}),
    ...(typeof metadata.session_kind === "string" ? { session_kind: metadata.session_kind } : {}),
    ...(shaField(metadata.turn_id) ? { turn_id: metadata.turn_id } : {}),
    ...(Array.isArray(metadata.typed_paths) ? { typed_paths: metadata.typed_paths.filter((p): p is string => typeof p === "string") } : {}),
    ...(REVIEW_STATUSES.has(metadata.status as ReviewStatus) ? { status: metadata.status as ReviewStatus } : {}),
  });
}

export function projectSourceCompileEvents(events: readonly SkillwikiLogEventV1[]): Result<SourceCompileEvent[]> {
  const out: SourceCompileEvent[] = [];
  for (const event of events) {
    const parsed = parseSourceCompileEvent(event);
    if (!parsed.ok) return parsed;
    if (parsed.data) out.push(parsed.data);
  }
  return ok(out.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.operation_id.localeCompare(b.operation_id)));
}

export async function readSourceCompileEvents(vault: string): Promise<Result<SourceCompileEvent[]>> {
  const events = await readLogEvents(vault);
  if (!events.ok) return events;
  return projectSourceCompileEvents(events.data);
}

export function effectiveCompileState(input: {
  events: readonly SourceCompileEvent[];
  rawPath: string;
  completeSha256: string;
  now: string;
}): CompileState {
  const mine = input.events.filter((event) => event.raw_path === input.rawPath);
  const latestWithSha = [...mine].reverse().find((event) => event.complete_sha256);
  const identityMismatch = Boolean(latestWithSha?.complete_sha256 && latestWithSha.complete_sha256 !== input.completeSha256);
  if (identityMismatch) return { status: "none", identityMismatch: true, claim: latestWithSha };
  const latest = mine.at(-1);
  if (!latest) return { status: "none", identityMismatch: false };
  const claim = [...mine].reverse().find((event) => event.kind === "source-compile-claimed");
  const published = [...mine].reverse().find((event) => event.kind === "source-compile-published");
  const review = [...mine].reverse().find((event) => event.kind === "source-review");
  if (latest.kind === "source-review") {
    const status = latest.status === "accepted" || latest.status === "dismissed" ? "review-closed" : "review-open";
    return { status, identityMismatch: false, claim, published, review };
  }
  if (latest.kind === "source-compile-published") {
    return { status: "review-open", identityMismatch: false, claim, published, review };
  }
  if (latest.kind === "source-compile-released") {
    return { status: "none", identityMismatch: false, claim, published, review };
  }
  if (latest.kind === "source-compile-claimed") {
    const expired = latest.expires_at ? latest.expires_at < input.now : false;
    return { status: expired ? "none" : "compiling", identityMismatch: false, claim: latest, published, review };
  }
  return { status: "none", identityMismatch: false, claim, published, review };
}

async function loadContext(input: { vault: string; rawPath: string; now?: string }): Promise<Result<{
  text: string;
  completeHash: string;
  events: SourceCompileEvent[];
  state: CompileState;
  lifecycle: string;
}>> {
  const target = exactActiveArticleOrPaper(input.rawPath);
  if (!target.ok) return target;
  const resolved = await resolveExistingRegularFileInsideVault(input.vault, input.rawPath);
  if (!resolved.ok) return err("FILE_NOT_FOUND", { path: input.rawPath, cause: resolved });
  const text = await readFile(resolved.data, "utf8");
  const completeHash = completeSha256(text);
  const events = await readSourceCompileEvents(input.vault);
  if (!events.ok) return events;
  const now = input.now ?? new Date().toISOString();
  const state = effectiveCompileState({ events: events.data, rawPath: input.rawPath, completeSha256: completeHash, now });
  const inventory = await inventorySources({ vault: input.vault });
  const item = inventory.output?.items.find((entry) => entry.raw_path === input.rawPath);
  return ok({
    text,
    completeHash,
    events: events.data,
    state,
    lifecycle: item?.lifecycle_status ?? "pending",
  });
}

export async function planSourceCompileClaim(input: {
  vault: string;
  rawPath: string;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  now?: string;
}): Promise<Result<SourceCompilePlan>> {
  const interactive = requireInteractive(input.sessionKind);
  if (!interactive.ok) return interactive;
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  const ctx = await loadContext(input);
  if (!ctx.ok) return ctx;
  if (ctx.data.lifecycle !== "pending") {
    return err("SOURCE_COMPILE_NOT_PENDING", { path: input.rawPath, lifecycle: ctx.data.lifecycle });
  }
  const actor = input.actor ?? "skillwiki-cli";
  const hostId = input.hostId ?? "local";
  if (ctx.data.state.status === "compiling" && ctx.data.state.claim) {
    const held = ctx.data.state.claim;
    if (held.actor !== actor || held.host_id !== hostId) {
      return err("SOURCE_COMPILE_CLAIM_HELD", { actor: held.actor, host_id: held.host_id, expires_at: held.expires_at });
    }
  }
  const occurredAt = input.now ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(occurredAt) + COMPILE_CLAIM_TTL_MS).toISOString();
  const turnId = operationId("source-compile-turn", [input.rawPath, ctx.data.completeHash, occurredAt]);
  const operation_id = operationId("source-compile-claimed", [input.rawPath, ctx.data.completeHash, actor, hostId, reason.data, occurredAt]);
  const base = {
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    expires_at: expiresAt,
    turn_id: turnId,
    contract: "source-compile-claim/v1",
    actor,
    host_id: hostId,
    reason: reason.data,
    session_kind: input.sessionKind,
  };
  return ok({
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    expires_at: expiresAt,
    turn_id: turnId,
    approval_token: encodeSourceActionApproval(base),
    write: false,
  });
}

export async function applySourceCompileClaim(input: {
  vault: string;
  rawPath: string;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  approve: string;
}): Promise<Result<{ event_path: string; operation_id: string; created: boolean }>> {
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceCompileClaim({ ...input, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source compile claim approval does not match live state" });
  const event = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-compile-claimed",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      expires_at: planned.data.expires_at,
      session_kind: input.sessionKind,
      reason: input.reason.normalize("NFC").trim(),
      turn_id: planned.data.turn_id,
    },
  });
  if (!event.ok) return event;
  return ok({ event_path: event.data.path, operation_id: planned.data.operation_id, created: event.data.created });
}

export async function planSourceCompileRelease(input: {
  vault: string;
  rawPath: string;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  now?: string;
}): Promise<Result<SourceCompilePlan>> {
  const interactive = requireInteractive(input.sessionKind);
  if (!interactive.ok) return interactive;
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  const ctx = await loadContext(input);
  if (!ctx.ok) return ctx;
  if (ctx.data.state.status !== "compiling" || !ctx.data.state.claim) {
    return err("SOURCE_COMPILE_NOT_HELD", { path: input.rawPath });
  }
  const occurredAt = input.now ?? new Date().toISOString();
  const operation_id = operationId("source-compile-released", [input.rawPath, ctx.data.completeHash, reason.data, occurredAt]);
  const base = {
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    contract: "source-compile-release/v1",
    reason: reason.data,
  };
  return ok({
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    approval_token: encodeSourceActionApproval(base),
    write: false,
  });
}

export async function applySourceCompileRelease(input: {
  vault: string;
  rawPath: string;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  approve: string;
}): Promise<Result<{ event_path: string; operation_id: string; created: boolean }>> {
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceCompileRelease({ ...input, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source compile release approval does not match live state" });
  const event = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-compile-released",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      reason: input.reason.normalize("NFC").trim(),
    },
  });
  if (!event.ok) return event;
  return ok({ event_path: event.data.path, operation_id: planned.data.operation_id, created: event.data.created });
}

function normalizePages(pages: readonly string[]): Result<string[]> {
  const cleaned = pages.map((page) => page.replaceAll("\\", "/").trim()).filter(Boolean);
  if (cleaned.length === 0) return err("SOURCE_COMPILE_PAGES_INVALID", { message: "at least one typed page is required" });
  for (const page of cleaned) {
    if (!TYPED_PAGE_PATH.test(page)) return err("SOURCE_COMPILE_PAGES_INVALID", { path: page });
  }
  return ok([...new Set(cleaned)]);
}

export async function planSourceCompilePublished(input: {
  vault: string;
  rawPath: string;
  pages: readonly string[];
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  now?: string;
}): Promise<Result<SourceCompilePlan>> {
  const interactive = requireInteractive(input.sessionKind);
  if (!interactive.ok) return interactive;
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  const pages = normalizePages(input.pages);
  if (!pages.ok) return pages;
  const ctx = await loadContext(input);
  if (!ctx.ok) return ctx;
  if (ctx.data.lifecycle !== "pending" && ctx.data.lifecycle !== "integrated") {
    return err("SOURCE_COMPILE_NOT_PENDING", { path: input.rawPath, lifecycle: ctx.data.lifecycle });
  }
  const turnId = ctx.data.state.claim?.turn_id ?? operationId("source-compile-turn", [input.rawPath, ctx.data.completeHash, input.now ?? ""]);
  const occurredAt = input.now ?? new Date().toISOString();
  const operation_id = operationId("source-compile-published", [input.rawPath, ctx.data.completeHash, pages.data.join(","), occurredAt]);
  const review_operation_id = operationId("source-review-open", [input.rawPath, turnId, occurredAt]);
  const base = {
    operation_id,
    review_operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    typed_paths: pages.data,
    turn_id: turnId,
    contract: "source-compile-published/v1",
    reason: reason.data,
  };
  return ok({
    operation_id,
    review_operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    typed_paths: pages.data,
    turn_id: turnId,
    approval_token: encodeSourceActionApproval(base),
    write: false,
  });
}

export async function applySourceCompilePublished(input: {
  vault: string;
  rawPath: string;
  pages: readonly string[];
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  approve: string;
}): Promise<Result<{ event_path: string; review_event_path: string; operation_id: string; created: boolean }>> {
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceCompilePublished({ ...input, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source compile published approval does not match live state" });
  const hostId = input.hostId ?? "local";
  const actor = input.actor ?? "skillwiki-cli";
  const published = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: hostId,
    actor,
    kind: "source-compile-published",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      typed_paths: planned.data.typed_paths,
      turn_id: planned.data.turn_id,
    },
  });
  if (!published.ok) return published;
  const review = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.review_operation_id ?? operationId("source-review-open", [input.rawPath, planned.data.turn_id ?? "", planned.data.occurred_at]),
    occurred_at: planned.data.occurred_at,
    host_id: hostId,
    actor,
    kind: "source-review",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      turn_id: planned.data.turn_id,
      status: "open",
      typed_paths: planned.data.typed_paths,
      reason: input.reason.normalize("NFC").trim(),
    },
  });
  if (!review.ok) return review;
  return ok({
    event_path: published.data.path,
    review_event_path: review.data.path,
    operation_id: planned.data.operation_id,
    created: published.data.created,
  });
}

export async function planSourceReview(input: {
  vault: string;
  rawPath: string;
  status: ReviewStatus;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  now?: string;
}): Promise<Result<SourceCompilePlan>> {
  const interactive = requireInteractive(input.sessionKind);
  if (!interactive.ok) return interactive;
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  if (!REVIEW_STATUSES.has(input.status)) return err("SOURCE_COMPILE_INVALID", { field: "status" });
  const ctx = await loadContext(input);
  if (!ctx.ok) return ctx;
  const turnId = ctx.data.state.review?.turn_id ?? ctx.data.state.published?.turn_id ?? ctx.data.state.claim?.turn_id;
  if (!turnId) return err("SOURCE_COMPILE_REVIEW_MISSING", { path: input.rawPath });
  const occurredAt = input.now ?? new Date().toISOString();
  const operation_id = operationId("source-review", [input.rawPath, turnId, input.status, reason.data, occurredAt]);
  const typedPaths = ctx.data.state.review?.typed_paths ?? ctx.data.state.published?.typed_paths;
  const base = {
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    turn_id: turnId,
    status: input.status,
    contract: "source-review/v1",
    reason: reason.data,
  };
  return ok({
    operation_id,
    occurred_at: occurredAt,
    raw_path: input.rawPath,
    complete_sha256: ctx.data.completeHash,
    turn_id: turnId,
    status: input.status,
    typed_paths: typedPaths,
    approval_token: encodeSourceActionApproval(base),
    write: false,
  });
}

export async function applySourceReview(input: {
  vault: string;
  rawPath: string;
  status: ReviewStatus;
  reason: string;
  sessionKind: SessionKindName;
  actor?: string;
  hostId?: string;
  approve: string;
}): Promise<Result<{ event_path: string; operation_id: string; created: boolean }>> {
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceReview({ ...input, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source review approval does not match live state" });
  const event = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-review",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      turn_id: planned.data.turn_id,
      status: input.status,
      ...(planned.data.typed_paths ? { typed_paths: planned.data.typed_paths } : {}),
      reason: input.reason.normalize("NFC").trim(),
    },
  });
  if (!event.ok) return event;
  return ok({ event_path: event.data.path, operation_id: planned.data.operation_id, created: event.data.created });
}

export async function listCompileStatus(input: { vault: string; now?: string }): Promise<Result<{ items: Array<{ raw_path: string; status: CompileProjectionStatus; identityMismatch: boolean }> }>> {
  const inventory = await inventorySources({ vault: input.vault });
  if (!inventory.output) return err("SOURCE_COMPILE_INVENTORY_FAILED", { cause: inventory.error });
  const events = await readSourceCompileEvents(input.vault);
  if (!events.ok) return events;
  const now = input.now ?? new Date().toISOString();
  const items = [];
  for (const item of inventory.output.items) {
    const textResult = await resolveExistingRegularFileInsideVault(input.vault, item.raw_path);
    if (!textResult.ok) continue;
    const text = await readFile(textResult.data, "utf8");
    const state = effectiveCompileState({
      events: events.data,
      rawPath: item.raw_path,
      completeSha256: completeSha256(text),
      now,
    });
    if (state.status === "none" && !state.identityMismatch) continue;
    if (state.status === "review-closed") continue;
    items.push({ raw_path: item.raw_path, status: state.status, identityMismatch: state.identityMismatch });
  }
  return ok({ items });
}

export async function listSourceReviews(input: { vault: string; now?: string }): Promise<Result<{ items: Array<{ raw_path: string; status: ReviewStatus; typed_paths?: string[] }> }>> {
  const events = await readSourceCompileEvents(input.vault);
  if (!events.ok) return events;
  const now = input.now ?? new Date().toISOString();
  const byPath = new Map<string, SourceCompileEvent[]>();
  for (const event of events.data) {
    const list = byPath.get(event.raw_path) ?? [];
    list.push(event);
    byPath.set(event.raw_path, list);
  }
  const items: Array<{ raw_path: string; status: ReviewStatus; typed_paths?: string[] }> = [];
  for (const [rawPath, pathEvents] of byPath) {
    const latestSha = [...pathEvents].reverse().find((event) => event.complete_sha256)?.complete_sha256 ?? "0".repeat(64);
    const state = effectiveCompileState({ events: pathEvents, rawPath, completeSha256: latestSha, now });
    if (state.status !== "review-open" || !state.review?.status) continue;
    items.push({ raw_path: rawPath, status: state.review.status, typed_paths: state.review.typed_paths });
  }
  return ok({ items });
}
