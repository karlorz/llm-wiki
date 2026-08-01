import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import {
  inventorySources,
  sourceMatches,
  type SourceCaptureChannel,
  type SourceLifecycleItem,
  type SourceInventoryOutput,
} from "../utils/source-lifecycle.js";

export type SourceScope = "articles" | "papers" | "all";
export type SourceSort = "newest" | "oldest";

export interface SourcesPendingInput {
  vault: string;
  today?: string;
  since?: string;
  olderThan?: number;
  match?: string;
  ingestedBy?: "manual" | "wiki-ingest" | "proj-work" | "unknown";
  scope?: SourceScope;
  sort?: SourceSort;
  limit?: number;
  all?: boolean;
  includeIntegrated?: boolean;
  includeArchived?: boolean;
  includeDuplicates?: boolean;
  includeLegacyArchived?: boolean;
}

export interface SourcesPendingSummary {
  total: number;
  pending: number;
  integrated: number;
  valid: number;
  legacy: number;
  invalid: number;
  fresh: number;
  aging: number;
  stale: number;
  old: number;
  unknown_age: number;
}

export interface SourcesPendingOutput {
  items: SourceLifecycleItem[];
  summary: SourcesPendingSummary;
  diagnostics: SourceInventoryOutput["diagnostics"];
  humanHint: string;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validate(input: SourcesPendingInput): Result<true> {
  if (input.since && !validDate(input.since)) return err("SOURCES_DATE_INVALID", { field: "since", value: input.since });
  if (input.olderThan !== undefined && (!Number.isInteger(input.olderThan) || input.olderThan < 0)) {
    return err("SOURCES_AGE_INVALID", { field: "older-than", value: input.olderThan });
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000)) {
    return err("SOURCES_LIMIT_INVALID", { value: input.limit });
  }
  if (input.scope && !(["articles", "papers", "all"] as const).includes(input.scope)) {
    return err("SOURCES_SCOPE_INVALID", { value: input.scope });
  }
  if (input.sort && !(["newest", "oldest"] as const).includes(input.sort)) {
    return err("SOURCES_SORT_INVALID", { value: input.sort });
  }
  return ok(true);
}

function channelMatches(item: SourceLifecycleItem, selected: SourcesPendingInput["ingestedBy"]): boolean {
  if (!selected) return true;
  const channel: SourceCaptureChannel = item.capture_channel;
  if (selected === "manual") return channel === "manual" || channel === "web-clipper-legacy";
  return channel === selected;
}

function summary(items: SourceLifecycleItem[]): SourcesPendingSummary {
  return {
    total: items.length,
    pending: items.filter((item) => item.lifecycle_status === "pending").length,
    integrated: items.filter((item) => item.lifecycle_status === "integrated").length,
    valid: items.filter((item) => item.schema_status === "valid").length,
    legacy: items.filter((item) => item.schema_status === "legacy").length,
    invalid: items.filter((item) => item.schema_status === "invalid").length,
    fresh: items.filter((item) => item.age_bucket === "fresh").length,
    aging: items.filter((item) => item.age_bucket === "aging").length,
    stale: items.filter((item) => item.age_bucket === "stale").length,
    old: items.filter((item) => item.age_bucket === "old").length,
    unknown_age: items.filter((item) => item.age_bucket === "unknown").length,
  };
}

export async function runSourcesPending(input: SourcesPendingInput): Promise<{ exitCode: number; result: Result<SourcesPendingOutput> }> {
  const validated = validate(input);
  if (!validated.ok) return { exitCode: ExitCode.USAGE, result: validated };
  const inventory = await inventorySources({ vault: input.vault, today: input.today });
  if (!inventory.output) {
    return { exitCode: inventory.exitCode, result: inventory.error as Result<SourcesPendingOutput> };
  }

  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const cutoff = input.olderThan === undefined
    ? null
    : new Date(Date.parse(`${today}T00:00:00Z`) - input.olderThan * 86_400_000).toISOString().slice(0, 10);
  let items = inventory.output.items.filter((item) => {
    if (!input.includeIntegrated && item.lifecycle_status !== "pending") return false;
    if (!input.includeArchived && item.storage_status === "archived") return false;
    if (!input.includeDuplicates && item.storage_status === "duplicate") return false;
    if (!input.includeLegacyArchived && item.storage_status === "legacy-archived") return false;
    if (input.scope && input.scope !== "all" && !item.raw_path.startsWith(`raw/${input.scope}/`) && !item.raw_path.includes(`/${input.scope}/`)) return false;
    if (input.since && (!item.captured || item.captured < input.since)) return false;
    if (cutoff && (!item.captured || item.captured > cutoff)) return false;
    if (input.match && !sourceMatches(item, input.match)) return false;
    if (!channelMatches(item, input.ingestedBy)) return false;
    return true;
  });

  if ((input.sort ?? "newest") === "oldest") {
    items = items.sort((a, b) => (a.captured ?? "9999-99-99").localeCompare(b.captured ?? "9999-99-99") || a.raw_path.localeCompare(b.raw_path));
  }
  const counts = summary(items);
  const unbounded = input.all === true;
  items = items.slice(0, unbounded ? undefined : (input.limit ?? 50));
  const visibleRawPaths = new Set(items.map(item => item.raw_path));
  const diagnostics = inventory.output.diagnostics.filter(diagnostic =>
    visibleRawPaths.has(diagnostic.raw_path) || diagnostic.raw_path === "meta/log-events"
  );
  const humanHint = items.length === 0
    ? "no pending sources"
    : items.map((item) => `${item.captured ?? "unknown-date"} ${item.schema_status} ${item.raw_path} — ${item.title}`).join("\n");
  return { exitCode: ExitCode.OK, result: ok({ items, summary: counts, diagnostics, humanHint }) };
}
