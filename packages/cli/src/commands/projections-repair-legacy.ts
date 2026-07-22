import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { atomicWriteText, type AtomicWriteOutput } from "../utils/atomic-write.js";
import { UNMANAGED_END, UNMANAGED_START } from "../utils/index-projection.js";
import {
  canonicalEventJson,
  eventPathFor,
  validateLogEvent,
  type SkillwikiLogEventV1,
} from "../utils/log-events.js";

const OPERATION_ID_RE = /^[0-9a-f]{64}$/;
const LEGACY_KEYS = ["created", "kind", "note", "operation_id", "target"];
const EVENT_KEYS = [
  "actor",
  "host_id",
  "kind",
  "metadata",
  "note",
  "occurred_at",
  "operation_id",
  "schema",
  "target",
];

export interface ProjectionsRepairLegacyInput {
  vault: string;
  eventOperationId: string;
  write: boolean;
  hostId?: string;
}

export interface ProjectionsRepairLegacyOutput {
  event_path: string;
  index_repair_needed: boolean;
  event_repair_needed: boolean;
  index_changed: boolean;
  event_changed: boolean;
  rolled_back: boolean;
  dry_run: boolean;
  humanHint: string;
}

export interface ProjectionsRepairLegacyDeps {
  writeText(path: string, text: string): Promise<Result<AtomicWriteOutput>>;
}

interface RepairPlan {
  current: string;
  repaired: string;
  needed: boolean;
}

interface EventRepairPlan extends RepairPlan {
  absolutePath: string;
  relativePath: string;
}

const defaultDeps: ProjectionsRepairLegacyDeps = {
  writeText: (path, text) => atomicWriteText(path, text),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

function planIndexRepair(current: string): Result<RepairPlan> {
  if (count(current, UNMANAGED_START) !== 1 || count(current, UNMANAGED_END) !== 1) {
    return err("SCHEME_REJECTED", {
      path: "index.md",
      message: "index.md must contain exactly one complete unmanaged marker pair",
    });
  }

  const start = current.indexOf(UNMANAGED_START);
  const end = current.indexOf(UNMANAGED_END);
  if (start < end) return ok({ current, repaired: current, needed: false });

  const between = current.slice(end + UNMANAGED_END.length, start);
  if (!/^\s*$/.test(between)) {
    return err("SCHEME_REJECTED", {
      path: "index.md",
      message: "reversed unmanaged markers must be adjacent except for whitespace",
    });
  }

  const repaired =
    current.slice(0, end) +
    UNMANAGED_START +
    between +
    UNMANAGED_END +
    current.slice(start + UNMANAGED_START.length);
  return ok({ current, repaired, needed: true });
}

function normalizeLegacyTimestamp(value: unknown): Result<string> {
  if (typeof value !== "string") {
    return err("SCHEME_REJECTED", { message: "legacy event created must be a UTC timestamp" });
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}))?Z$/);
  if (!match) {
    return err("SCHEME_REJECTED", { message: "legacy event created must be a UTC timestamp" });
  }
  const normalized = `${match[1]}.${match[2] ?? "000"}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) {
    return err("SCHEME_REJECTED", { message: "legacy event created is not a valid timestamp" });
  }
  return ok(normalized);
}

async function findEventPath(vault: string, operationId: string): Promise<Result<{ absolute: string; relative: string }>> {
  const root = join(vault, "meta", "log-events");
  const matches: Array<{ absolute: string; relative: string }> = [];
  let days;
  try {
    days = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    return err("SCHEME_REJECTED", {
      message: "log event root is missing or unreadable",
      detail: String(error),
    });
  }

  for (const day of days) {
    if (!day.isDirectory()) continue;
    const dayPath = join(root, day.name);
    const entries = await readdir(dayPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== `${operationId}.json`) continue;
      matches.push({
        absolute: join(dayPath, entry.name),
        relative: `meta/log-events/${day.name}/${entry.name}`,
      });
    }
  }

  if (matches.length !== 1) {
    return err("SCHEME_REJECTED", {
      message: "event operation ID must resolve to exactly one log event",
      operation_id: operationId,
      matches: matches.map((match) => match.relative),
    });
  }
  return ok(matches[0]!);
}

function planCanonicalEvent(
  parsed: Record<string, unknown>,
  operationId: string,
  relativePath: string,
  current: string,
): Result<RepairPlan> {
  if (!hasExactKeys(parsed, EVENT_KEYS)) {
    return err("SCHEME_REJECTED", { path: relativePath, message: "canonical event has unexpected fields" });
  }
  const validated = validateLogEvent(parsed as unknown as SkillwikiLogEventV1);
  if (!validated.ok) return validated;
  if (validated.data.operation_id !== operationId || eventPathFor(validated.data) !== relativePath) {
    return err("SCHEME_REJECTED", { path: relativePath, message: "path/identity mismatch" });
  }
  return ok({ current, repaired: current, needed: false });
}

function planLegacyEvent(
  parsed: Record<string, unknown>,
  operationId: string,
  relativePath: string,
  current: string,
  hostId: string,
): Result<RepairPlan> {
  if (!hasExactKeys(parsed, LEGACY_KEYS)) {
    return err("SCHEME_REJECTED", {
      path: relativePath,
      message: "legacy event must contain exactly operation_id, kind, target, note, and created",
    });
  }
  if (parsed.operation_id !== operationId) {
    return err("SCHEME_REJECTED", { path: relativePath, message: "path/identity mismatch" });
  }
  const { kind, target, note } = parsed;
  if (typeof kind !== "string" || typeof target !== "string" || typeof note !== "string") {
    return err("SCHEME_REJECTED", {
      path: relativePath,
      message: "legacy event kind, target, and note must be strings",
    });
  }
  const occurredAt = normalizeLegacyTimestamp(parsed.created);
  if (!occurredAt.ok) return occurredAt;
  const event: SkillwikiLogEventV1 = {
    schema: "skillwiki-log-event/v1",
    operation_id: operationId,
    occurred_at: occurredAt.data,
    host_id: hostId,
    actor: "skillwiki-cli",
    kind,
    target,
    note,
    metadata: {},
  };
  const validated = validateLogEvent(event);
  if (!validated.ok) return validated;
  if (eventPathFor(validated.data) !== relativePath) {
    return err("SCHEME_REJECTED", { path: relativePath, message: "path/date mismatch" });
  }
  return ok({ current, repaired: canonicalEventJson(validated.data), needed: true });
}

async function planEventRepair(
  vault: string,
  operationId: string,
  hostId: string,
): Promise<Result<EventRepairPlan>> {
  const located = await findEventPath(vault, operationId);
  if (!located.ok) return located;
  let current: string;
  try {
    current = await readFile(located.data.absolute, "utf8");
  } catch (error: unknown) {
    return err("SCHEME_REJECTED", {
      path: located.data.relative,
      message: "event is unreadable",
      detail: String(error),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return err("SCHEME_REJECTED", { path: located.data.relative, message: "invalid JSON" });
  }
  if (!isPlainObject(parsed)) {
    return err("SCHEME_REJECTED", { path: located.data.relative, message: "event must be an object" });
  }

  const plan = parsed.schema === "skillwiki-log-event/v1"
    ? planCanonicalEvent(parsed, operationId, located.data.relative, current)
    : planLegacyEvent(parsed, operationId, located.data.relative, current, hostId);
  if (!plan.ok) return plan;
  return ok({ ...plan.data, absolutePath: located.data.absolute, relativePath: located.data.relative });
}

export async function runProjectionsRepairLegacy(
  input: ProjectionsRepairLegacyInput,
  deps: ProjectionsRepairLegacyDeps = defaultDeps,
): Promise<{ exitCode: number; result: Result<ProjectionsRepairLegacyOutput> }> {
  if (!OPERATION_ID_RE.test(input.eventOperationId)) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { message: "event operation ID must be 64 lowercase hex chars" }),
    };
  }

  let indexText: string;
  try {
    indexText = await readFile(join(input.vault, "index.md"), "utf8");
  } catch (error: unknown) {
    return {
      exitCode: ExitCode.SCHEME_REJECTED,
      result: err("SCHEME_REJECTED", { path: "index.md", message: "index.md is unreadable", detail: String(error) }),
    };
  }
  const indexPlan = planIndexRepair(indexText);
  if (!indexPlan.ok) return { exitCode: ExitCode.SCHEME_REJECTED, result: indexPlan };
  const eventPlan = await planEventRepair(
    input.vault,
    input.eventOperationId,
    input.hostId ?? "standalone",
  );
  if (!eventPlan.ok) return { exitCode: ExitCode.SCHEME_REJECTED, result: eventPlan };

  const baseOutput = {
    event_path: eventPlan.data.relativePath,
    index_repair_needed: indexPlan.data.needed,
    event_repair_needed: eventPlan.data.needed,
  };
  if (!input.write) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        ...baseOutput,
        index_changed: false,
        event_changed: false,
        rolled_back: false,
        dry_run: true,
        humanHint: `dry run: index_repair_needed=${indexPlan.data.needed} event_repair_needed=${eventPlan.data.needed}`,
      }),
    };
  }

  let indexChanged = false;
  if (indexPlan.data.needed) {
    const written = await deps.writeText(join(input.vault, "index.md"), indexPlan.data.repaired);
    if (!written.ok) return { exitCode: ExitCode.WRITE_FAILED, result: written };
    indexChanged = written.data.changed;
  }

  let eventChanged = false;
  if (eventPlan.data.needed) {
    const written = await deps.writeText(eventPlan.data.absolutePath, eventPlan.data.repaired);
    if (!written.ok) {
      let rolledBack = false;
      let rollbackError: unknown;
      if (indexChanged) {
        const rollback = await deps.writeText(join(input.vault, "index.md"), indexPlan.data.current);
        rolledBack = rollback.ok;
        if (!rollback.ok) rollbackError = rollback;
      }
      return {
        exitCode: ExitCode.WRITE_FAILED,
        result: err("WRITE_FAILED", {
          message: "event repair failed",
          cause: written,
          rolled_back: rolledBack,
          rollback_error: rollbackError,
        }),
      };
    }
    eventChanged = written.data.changed;
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      ...baseOutput,
      index_changed: indexChanged,
      event_changed: eventChanged,
      rolled_back: false,
      dry_run: false,
      humanHint: `repaired legacy projections index_changed=${indexChanged} event_changed=${eventChanged}`,
    }),
  };
}
