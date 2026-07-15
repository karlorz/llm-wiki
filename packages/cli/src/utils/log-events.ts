import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@skillwiki/shared";
import { scanSensitiveContent } from "./sensitive-content.js";

export interface SkillwikiLogEventV1 {
  schema: "skillwiki-log-event/v1";
  operation_id: string;
  occurred_at: string;
  host_id: string;
  actor: string;
  kind: string;
  target: string;
  note: string;
  metadata: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key]);
  }
  return out;
}

export function eventPathFor(event: SkillwikiLogEventV1): string {
  const day = event.occurred_at.slice(0, 10);
  return `meta/log-events/${day}/${event.operation_id}.json`;
}

export function validateLogEvent(event: SkillwikiLogEventV1): Result<SkillwikiLogEventV1> {
  if (event.schema !== "skillwiki-log-event/v1") {
    return err("SCHEME_REJECTED", { message: "invalid event schema" });
  }
  if (!/^[0-9a-f]{64}$/.test(event.operation_id)) {
    return err("SCHEME_REJECTED", { message: "operation_id must be 64 hex chars" });
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurred_at)) {
    return err("SCHEME_REJECTED", { message: "occurred_at must be UTC ISO with milliseconds" });
  }
  for (const field of ["host_id", "actor", "kind", "target", "note"] as const) {
    const v = event[field];
    if (typeof v !== "string" || v.trim().length === 0 || v.length > 500) {
      return err("SCHEME_REJECTED", { message: `invalid ${field}` });
    }
  }
  if (!isPlainObject(event.metadata)) {
    return err("SCHEME_REJECTED", { message: "metadata must be a plain object" });
  }
  const sensitive = scanSensitiveContent(JSON.stringify(event));
  if (sensitive.length > 0) {
    return err("SENSITIVE_CONTENT_DETECTED", { findings: sensitive });
  }
  return ok({
    schema: "skillwiki-log-event/v1",
    operation_id: event.operation_id,
    occurred_at: event.occurred_at,
    host_id: event.host_id,
    actor: event.actor,
    kind: event.kind,
    target: event.target,
    note: event.note,
    metadata: canonicalize(event.metadata) as Record<string, unknown>,
  });
}

export function canonicalEventJson(event: SkillwikiLogEventV1): string {
  const ordered = {
    schema: event.schema,
    operation_id: event.operation_id,
    occurred_at: event.occurred_at,
    host_id: event.host_id,
    actor: event.actor,
    kind: event.kind,
    target: event.target,
    note: event.note,
    metadata: event.metadata,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export async function writeLogEvent(
  vault: string,
  event: SkillwikiLogEventV1,
): Promise<Result<{ path: string; created: boolean }>> {
  const validated = validateLogEvent(event);
  if (!validated.ok) return validated;
  const rel = eventPathFor(validated.data);
  const abs = join(vault, rel);
  await mkdir(join(vault, "meta", "log-events", validated.data.occurred_at.slice(0, 10)), {
    recursive: true,
  });
  const body = canonicalEventJson(validated.data);
  try {
    const handle = await open(abs, "wx");
    try {
      await handle.writeFile(body, "utf8");
    } finally {
      await handle.close();
    }
    return ok({ path: rel, created: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let existing: string;
      try {
        existing = await readFile(abs, "utf8");
      } catch (readErr: unknown) {
        return err("WRITE_FAILED", { path: rel, message: String(readErr) });
      }
      if (existing === body) return ok({ path: rel, created: false });
      return err("EVENT_IDENTITY_COLLISION", { path: rel });
    }
    return err("WRITE_FAILED", { path: rel, message: String(error) });
  }
}

export async function readLogEvents(vault: string): Promise<Result<SkillwikiLogEventV1[]>> {
  const root = join(vault, "meta", "log-events");
  let days: string[];
  try {
    days = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return ok([]);
  }
  const events: SkillwikiLogEventV1[] = [];
  for (const day of days) {
    const files = (await readdir(join(root, day))).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      const text = await readFile(join(root, day, file), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return err("SCHEME_REJECTED", { path: `meta/log-events/${day}/${file}`, message: "invalid JSON" });
      }
      const validated = validateLogEvent(parsed as SkillwikiLogEventV1);
      if (!validated.ok) return validated;
      if (eventPathFor(validated.data) !== `meta/log-events/${day}/${file}`) {
        return err("SCHEME_REJECTED", {
          path: `meta/log-events/${day}/${file}`,
          message: "path/identity mismatch",
        });
      }
      events.push(validated.data);
    }
  }
  events.sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? -1 : 1;
    return a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0;
  });
  return ok(events);
}
