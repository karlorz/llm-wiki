import { err, ok, type Result } from "@skillwiki/shared";
import { readLogEvents, type SkillwikiLogEventV1 } from "./log-events.js";

export interface SourceRelocation {
  operation_id: string;
  operation: "rename" | "relocate" | "archive" | "deduplicate";
  previous_path: string;
  current_path: string;
  source_sha256: string;
  occurred_at: string;
}

function parse(event: SkillwikiLogEventV1): Result<SourceRelocation | null> {
  if (event.kind !== "source-relocation") return ok(null);
  const metadata = event.metadata;
  const operation = metadata.operation;
  const previous = metadata.previous_path;
  const current = metadata.current_path;
  const hash = metadata.source_sha256;
  if (!(["rename", "relocate", "archive", "deduplicate"] as const).includes(operation as SourceRelocation["operation"])) {
    return err("SOURCE_RELOCATION_INVALID", { operation_id: event.operation_id, field: "operation" });
  }
  if (typeof previous !== "string" || typeof current !== "string" || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
    return err("SOURCE_RELOCATION_INVALID", { operation_id: event.operation_id, field: "metadata" });
  }
  return ok({
    operation_id: event.operation_id,
    operation: operation as SourceRelocation["operation"],
    previous_path: previous,
    current_path: current,
    source_sha256: hash,
    occurred_at: event.occurred_at,
  });
}

export function projectSourceRelocations(events: readonly SkillwikiLogEventV1[]): Result<SourceRelocation[]> {
  const out: SourceRelocation[] = [];
  for (const event of events) {
    const relocation = parse(event);
    if (!relocation.ok) return relocation;
    if (relocation.data) out.push(relocation.data);
  }
  return ok(out);
}

export async function readSourceRelocations(vault: string): Promise<Result<SourceRelocation[]>> {
  const events = await readLogEvents(vault);
  if (!events.ok) return events;
  return projectSourceRelocations(events.data);
}

export function buildSourceRelocationProjection(relocations: readonly SourceRelocation[]): Map<string, string> {
  const projection = new Map<string, string>();
  for (const relocation of relocations) {
    const current = projection.get(relocation.current_path) ?? relocation.current_path;
    projection.set(relocation.previous_path, current);
    for (const [historical, target] of projection) {
      if (target === relocation.previous_path) projection.set(historical, current);
    }
  }
  return projection;
}

export function resolveRelocatedSource(target: string, projection: ReadonlyMap<string, string>): string {
  let current = target;
  const seen = new Set<string>();
  while (projection.has(current) && !seen.has(current)) {
    seen.add(current);
    current = projection.get(current)!;
  }
  return current;
}
