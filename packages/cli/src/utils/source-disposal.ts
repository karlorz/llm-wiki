import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { err, ok, type Result } from "@skillwiki/shared";
import { buildDeleteIntent, pathToIntentFilename, writeDeleteIntent } from "./delete-intent.js";
import { writeLogEvent } from "./log-events.js";
import { operationId } from "./operation-id.js";
import { authorizeRawOperation, classifyRawPath } from "./raw-operation-policy.js";
import { buildRawAssetReferenceIndex } from "./raw-asset-reference-index.js";
import { buildSourceReferenceIndex } from "./source-reference-index.js";
import { buildSourceRelocationProjection, readSourceRelocations } from "./source-relocations.js";
import { decodeSourceActionApproval, encodeSourceActionApproval } from "./source-action-approval.js";
import { scanSensitiveContent } from "./sensitive-content.js";
import { scanVault } from "./vault.js";
import { resolveExistingRegularFileInsideVault } from "./vault-path-safety.js";

export interface SourceDisposalPlan {
  raw_path: string;
  complete_sha256: string;
  size_bytes: number;
  typed_references: string[];
  other_references: string[];
  asset_inbound_references: string[];
  delete_intent_path: string;
  recoverability: string;
  reason: string;
  operation_id: string;
  occurred_at: string;
  approval_token: string;
  write: false;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactTarget(path: string): Result<true> {
  if (/[?*\[\]{}]/.test(path) || !path.includes("/") || path.endsWith("/")) return err("RAW_DISPOSAL_TARGET_INVALID", { path, message: "exact file path required; globs, basenames, and directories are refused" });
  const classified = classifyRawPath(path);
  if (!classified.ok) return classified;
  return ok(true);
}

export async function planSourceDisposal(input: {
  vault: string;
  rawPath: string;
  reason: string;
  now?: string;
}): Promise<Result<SourceDisposalPlan>> {
  const exact = exactTarget(input.rawPath);
  if (!exact.ok) return exact;
  const authorized = authorizeRawOperation({
    operationClass: "destructive-remove",
    trigger: "attended-apply",
    source: input.rawPath,
    explicitExactTarget: true,
  });
  if (!authorized.ok) return authorized;
  const reason = input.reason.normalize("NFC").trim();
  if (!reason) return err("RAW_DISPOSAL_TARGET_INVALID", { field: "reason" });
  const sensitive = scanSensitiveContent(reason);
  if (sensitive.length > 0) return err("SENSITIVE_CONTENT_DETECTED", { findings: sensitive });
  const target = await resolveExistingRegularFileInsideVault(input.vault, input.rawPath);
  if (!target.ok) return err("RAW_DISPOSAL_TARGET_INVALID", { path: input.rawPath, cause: target });
  const bytes = await readFile(target.data);
  const size = bytes.byteLength;

  let typedReferences: string[] = [];
  let otherReferences: string[] = [];
  let assetInboundReferences: string[] = [];
  if (input.rawPath.startsWith("raw/assets/")) {
    const assets = await buildRawAssetReferenceIndex(input.vault);
    assetInboundReferences = assets.inbound.get(input.rawPath) ?? [];
  } else if (input.rawPath.endsWith(".md")) {
    const scan = await scanVault(input.vault);
    if (!scan.ok) return scan;
    const typedPaths = new Set(scan.data.typedKnowledge.map(page => page.relPath));
    const relocations = await readSourceRelocations(input.vault);
    if (!relocations.ok) return relocations;
    const refs = await buildSourceReferenceIndex({
      typedPages: scan.data.typedKnowledge,
      otherPages: scan.data.allMarkdown.filter(page => !typedPaths.has(page.relPath) && !page.relPath.startsWith("raw/")),
      availableRawPaths: scan.data.raw.map(page => page.relPath),
      relocationProjection: buildSourceRelocationProjection(relocations.data),
    });
    typedReferences = refs.integratedBy.get(input.rawPath) ?? [];
    otherReferences = refs.referencedElsewhereBy.get(input.rawPath) ?? [];
  }

  const completeHash = sha256(bytes);
  const occurredAt = input.now ?? new Date().toISOString();
  const deleteIntentPath = `meta/delete-intents/${pathToIntentFilename(input.rawPath)}`;
  const operation_id = operationId("source-disposal", [input.rawPath, completeHash, reason, ...typedReferences, ...otherReferences, ...assetInboundReferences]);
  const base = {
    raw_path: input.rawPath,
    complete_sha256: completeHash,
    size_bytes: size,
    typed_references: typedReferences,
    other_references: otherReferences,
    asset_inbound_references: assetInboundReferences,
    delete_intent_path: deleteIntentPath,
    recoverability: "Recoverable only from Git/S3 history or another backup after deletion; the delete intent prevents automatic resurrection.",
    reason,
    operation_id,
    occurred_at: occurredAt,
  };
  return ok({ ...base, approval_token: encodeSourceActionApproval({ contract: "source-disposal/v1", ...base }), write: false });
}

export async function applySourceDisposal(input: {
  vault: string;
  rawPath: string;
  reason: string;
  approve: string;
  attended: boolean;
  actor?: string;
  hostId?: string;
}): Promise<Result<{ removed: string; tombstone_path: string; event_path: string; operation_id: string }>> {
  if (!input.attended) return err("RAW_DISPOSAL_ATTENDED_REQUIRED", { message: "permanent disposal is refused in scheduled/headless sessions" });
  const authorized = authorizeRawOperation({
    operationClass: "destructive-remove",
    trigger: "attended-apply",
    source: input.rawPath,
    explicitExactTarget: true,
  });
  if (!authorized.ok) return authorized;
  const decoded = decodeSourceActionApproval(input.approve);
  if (!decoded.ok) return decoded;
  const occurredAt = typeof decoded.data.occurred_at === "string" ? decoded.data.occurred_at : undefined;
  const planned = await planSourceDisposal({ vault: input.vault, rawPath: input.rawPath, reason: input.reason, now: occurredAt });
  if (!planned.ok) return planned;
  if (planned.data.approval_token !== input.approve) return err("APPROVAL_INVALID", { message: "source disposal approval does not match live target or references" });

  const event = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-disposal-approved",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      typed_references: planned.data.typed_references,
      other_references: planned.data.other_references,
      asset_inbound_references: planned.data.asset_inbound_references,
      delete_intent_path: planned.data.delete_intent_path,
    },
  });
  if (!event.ok) return event;
  const tombstonePath = await writeDeleteIntent(input.vault, buildDeleteIntent({
    path: input.rawPath,
    action: "remove",
    actor: input.actor ?? "skillwiki-cli",
    source: "cli",
    reason: input.reason,
    created: planned.data.occurred_at,
  }));
  const target = await resolveExistingRegularFileInsideVault(input.vault, input.rawPath);
  if (!target.ok) return err("APPROVAL_INVALID", { message: "source disposal target is no longer a safe exact file", cause: target });
  await unlink(target.data);
  const completedOperationId = operationId("source-disposal-completed", [planned.data.operation_id]);
  const completed = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: completedOperationId,
    occurred_at: planned.data.occurred_at,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-disposal-completed",
    target: input.rawPath,
    note: input.reason,
    metadata: {
      approval_operation_id: planned.data.operation_id,
      raw_path: input.rawPath,
      complete_sha256: planned.data.complete_sha256,
      delete_intent_path: planned.data.delete_intent_path,
    },
  });
  if (!completed.ok) return completed;
  return ok({ removed: input.rawPath, tombstone_path: tombstonePath, event_path: completed.data.path, operation_id: planned.data.operation_id });
}
