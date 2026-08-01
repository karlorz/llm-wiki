import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { operationId } from "./operation-id.js";
import { writeLogEvent } from "./log-events.js";
import { authorizeRawOperation, classifyRawPath, type RawPreserveOperation } from "./raw-operation-policy.js";
import { resolveAbsentTargetInsideVault, resolveExistingRegularFileInsideVault } from "./vault-path-safety.js";

export interface RawStructuralPlan {
  operation: RawPreserveOperation;
  source: string;
  destination: string;
  source_sha256: string;
  destination_state: "absent";
  approval_token: string;
  operation_id: string;
}

export interface RawStructuralApplyOutput {
  operation: RawPreserveOperation;
  source: string;
  destination: string;
  source_sha256: string;
  destination_sha256: string;
  event_path: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function token(plan: Omit<RawStructuralPlan, "approval_token">): string {
  const payload = Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
  return `swraw1.${payload}.${sha256(Buffer.from(payload, "utf8"))}`;
}

export async function planRawStructuralMove(input: {
  vault: string;
  operation: RawPreserveOperation;
  source: string;
  destination: string;
}): Promise<Result<RawStructuralPlan>> {
  const sourcePath = classifyRawPath(input.source);
  if (!sourcePath.ok) return sourcePath;
  const destinationPath = classifyRawPath(input.destination);
  if (!destinationPath.ok) return destinationPath;
  if (sourcePath.data.category === "assets" || destinationPath.data.category === "assets") {
    return err("RAW_ASSET_PATH_FROZEN", {
      source: input.source,
      destination: input.destination,
      message: "referenced asset paths are stable; routine raw lifecycle moves never move assets",
    });
  }
  if (sourcePath.data.storage !== "active") {
    return err("RAW_SOURCE_NOT_ACTIVE", { path: input.source, storage: sourcePath.data.storage });
  }
  if (sourcePath.data.category !== destinationPath.data.category) {
    return err("RAW_MOVE_CATEGORY_MISMATCH", {
      source: input.source,
      destination: input.destination,
      source_category: sourcePath.data.category,
      destination_category: destinationPath.data.category,
    });
  }
  const expectedStorage = input.operation === "archive"
    ? "archived"
    : input.operation === "deduplicate"
      ? "duplicate"
      : "active";
  if (destinationPath.data.storage !== expectedStorage) {
    return err("RAW_MOVE_DESTINATION_INVALID", {
      operation: input.operation,
      destination: input.destination,
      expected_storage: expectedStorage,
      actual_storage: destinationPath.data.storage,
    });
  }
  const allowed = authorizeRawOperation({
    operationClass: "preserve-move",
    trigger: "attended-apply",
    source: input.source,
    destination: input.destination,
  });
  if (!allowed.ok) return allowed;
  if (input.source === input.destination) return err("RAW_MOVE_NOOP", { path: input.source });

  const sourceResolved = await resolveExistingRegularFileInsideVault(input.vault, input.source);
  if (!sourceResolved.ok) return err("RAW_SOURCE_UNSAFE", { path: input.source, cause: sourceResolved });
  const destinationResolved = await resolveAbsentTargetInsideVault(input.vault, input.destination);
  if (!destinationResolved.ok) {
    return destinationResolved.error === "RAW_DESTINATION_EXISTS"
      ? destinationResolved
      : err("RAW_DESTINATION_UNSAFE", { path: input.destination, cause: destinationResolved });
  }
  const sourceBytes = await readFile(sourceResolved.data);

  const sourceSha = sha256(sourceBytes);
  const operation_id = operationId("raw-structural", [input.operation, input.source, input.destination, sourceSha]);
  const base = {
    operation: input.operation,
    source: input.source,
    destination: input.destination,
    source_sha256: sourceSha,
    destination_state: "absent" as const,
    operation_id,
  };
  return ok({ ...base, approval_token: token(base) });
}

export async function applyRawStructuralMove(input: {
  vault: string;
  operation: RawPreserveOperation;
  source: string;
  destination: string;
  approve: string;
  actor?: string;
  hostId?: string;
  reason?: string;
  command?: string;
  citationChanges?: string[];
  now?: string;
  writeEvent?: typeof writeLogEvent;
}): Promise<Result<RawStructuralApplyOutput>> {
  const planned = await planRawStructuralMove(input);
  if (!planned.ok) return planned;
  if (input.approve !== planned.data.approval_token) {
    return err("APPROVAL_INVALID", { message: "raw structural approval does not match live state" });
  }

  const sourceResolved = await resolveExistingRegularFileInsideVault(input.vault, input.source);
  if (!sourceResolved.ok) return err("RAW_SOURCE_UNSAFE", { path: input.source, cause: sourceResolved });
  const destinationResolved = await resolveAbsentTargetInsideVault(input.vault, input.destination);
  if (!destinationResolved.ok) {
    return destinationResolved.error === "RAW_DESTINATION_EXISTS"
      ? destinationResolved
      : err("RAW_DESTINATION_UNSAFE", { path: input.destination, cause: destinationResolved });
  }
  const sourceAbs = sourceResolved.data;
  const destinationAbs = destinationResolved.data;
  await mkdir(dirname(destinationAbs), { recursive: true });
  try {
    await copyFile(sourceAbs, destinationAbs, constants.COPYFILE_EXCL);
  } catch (error) {
    return err("RAW_MOVE_COPY_FAILED", { source: input.source, destination: input.destination, message: String(error) });
  }

  const destinationBytes = await readFile(destinationAbs);
  const destinationSha = sha256(destinationBytes);
  if (destinationSha !== planned.data.source_sha256) {
    return err("RAW_MOVE_HASH_MISMATCH", { source: input.source, destination: input.destination, source_sha256: planned.data.source_sha256, destination_sha256: destinationSha });
  }

  const occurredAt = input.now ?? new Date().toISOString();
  const event = await (input.writeEvent ?? writeLogEvent)(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: planned.data.operation_id,
    occurred_at: occurredAt,
    host_id: input.hostId ?? "local",
    actor: input.actor ?? "skillwiki-cli",
    kind: "source-relocation",
    target: input.destination,
    note: input.reason ?? `${input.operation} ${input.source} to ${input.destination}`,
    metadata: {
      operation: input.operation,
      previous_path: input.source,
      current_path: input.destination,
      source_sha256: planned.data.source_sha256,
      destination_sha256: destinationSha,
      command: input.command ?? "skillwiki",
      authority: "attended-apply",
      citation_changes: input.citationChanges ?? [],
    },
  });
  if (!event.ok) return event;
  try {
    await unlink(sourceAbs);
  } catch (error) {
    return err("RAW_MOVE_SOURCE_RETAINED", {
      source: input.source,
      destination: input.destination,
      event_path: event.data.path,
      message: String(error),
    });
  }
  return ok({
    operation: planned.data.operation,
    source: planned.data.source,
    destination: planned.data.destination,
    source_sha256: planned.data.source_sha256,
    destination_sha256: destinationSha,
    event_path: event.data.path,
  });
}
