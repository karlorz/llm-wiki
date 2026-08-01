import { basename } from "node:path";
import { RawSourceSchema } from "@skillwiki/shared";
import { extractFrontmatter } from "../parsers/frontmatter.js";
import { readPage, scanVault } from "./vault.js";
import { buildSourceReferenceIndex } from "./source-reference-index.js";
import { bodySha256, completeSha256, effectiveSourceDisposition, projectSourceDispositions, type SourceDisposition } from "./source-dispositions.js";
import { buildSourceRelocationProjection, projectSourceRelocations } from "./source-relocations.js";
import { readLogEvents } from "./log-events.js";

export type SourceSchemaStatus = "valid" | "legacy" | "invalid";
export type SourceStorageStatus = "active" | "archived" | "duplicate" | "legacy-archived";
export type SourceLifecycleStatus = "pending" | "integrated" | "deferred" | "reviewed-no-op" | "duplicate" | "out-of-scope" | "superseded";
export type SourceDateSource = "ingested" | "created" | "filename" | "unavailable";
export type SourceAgeBucket = "fresh" | "aging" | "stale" | "old" | "unknown";
export type SourceCaptureChannel = "manual" | "wiki-ingest" | "proj-work" | "web-clipper-legacy" | "unknown";

export interface SourceLifecycleDiagnostic {
  raw_path: string;
  code: string;
  message: string;
}

export interface SourceLifecycleItem {
  raw_path: string;
  current_raw_path: string;
  historical_raw_paths: string[];
  storage_status: SourceStorageStatus;
  title: string;
  source_url: string | null;
  captured: string | null;
  date_source: SourceDateSource;
  age_bucket: SourceAgeBucket;
  capture_channel: SourceCaptureChannel;
  lifecycle_status: SourceLifecycleStatus;
  schema_status: SourceSchemaStatus;
  schema_issues: string[];
  reference_count: number;
  referenced_by: string[];
  referenced_elsewhere: string[];
  effective_disposition?: SourceDisposition;
  disposition_identity_mismatch?: boolean;
}

export interface SourceInventoryOutput {
  items: SourceLifecycleItem[];
  diagnostics: SourceLifecycleDiagnostic[];
}

function portableDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function filenameDate(path: string): string | null {
  const match = basename(path).match(/^(\d{4}-\d{2}-\d{2})(?:-|$)/);
  return match ? portableDate(match[1]) : null;
}

function captureDate(path: string, fm: Record<string, unknown>): { captured: string | null; source: SourceDateSource } {
  const ingested = portableDate(fm.ingested);
  if (ingested) return { captured: ingested, source: "ingested" };
  const created = portableDate(fm.created);
  if (created) return { captured: created, source: "created" };
  const fromName = filenameDate(path);
  if (fromName) return { captured: fromName, source: "filename" };
  return { captured: null, source: "unavailable" };
}

function ageBucket(captured: string | null, today: string): SourceAgeBucket {
  if (!captured) return "unknown";
  const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${captured}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days)) return "unknown";
  if (days <= 7) return "fresh";
  if (days <= 30) return "aging";
  if (days <= 90) return "stale";
  return "old";
}

function storageStatus(path: string): SourceStorageStatus {
  if (path.startsWith("raw/archived/")) return "archived";
  if (path.startsWith("raw/duplicates/")) return "duplicate";
  if (path.startsWith("_archive/raw/")) return "legacy-archived";
  return "active";
}

function supportedSource(path: string): boolean {
  return /^raw\/(articles|papers)\/.+\.md$/.test(path)
    || /^raw\/(archived|duplicates)\/(articles|papers)\/.+\.md$/.test(path)
    || /^_archive\/raw\/(articles|papers)\/.+\.md$/.test(path);
}

function channel(fm: Record<string, unknown>, schemaStatus: SourceSchemaStatus): SourceCaptureChannel {
  if (fm.ingested_by === "wiki-ingest") return "wiki-ingest";
  if (fm.ingested_by === "proj-work") return "proj-work";
  if (fm.ingested_by === "manual") return "manual";
  if (schemaStatus === "legacy" && typeof fm.source === "string") return "web-clipper-legacy";
  return "unknown";
}

function titleFor(path: string, fm: Record<string, unknown>): string {
  if (typeof fm.title === "string" && fm.title.trim()) return fm.title.trim();
  return basename(path, ".md");
}

function classifySchema(fmResult: ReturnType<typeof extractFrontmatter>): {
  fm: Record<string, unknown>;
  status: SourceSchemaStatus;
  issues: string[];
} {
  if (!fmResult.ok) {
    return { fm: {}, status: "invalid", issues: ["frontmatter is invalid or incomplete"] };
  }
  const fm = fmResult.data;
  const parsed = RawSourceSchema.safeParse(fm);
  if (parsed.success) return { fm, status: "valid", issues: [] };

  const issues: string[] = [];
  if (typeof fm.source === "string" && typeof fm.source_url !== "string") {
    issues.push("source_url missing; legacy source property found");
  }
  if (!portableDate(fm.ingested) && portableDate(fm.created)) issues.push("ingested missing");
  if (Object.keys(fm).length === 0) issues.push("frontmatter missing");
  for (const issue of parsed.error.issues.slice(0, 8)) {
    const message = `${issue.path.join(".") || "frontmatter"}: ${issue.message}`;
    if (!issues.includes(message)) issues.push(message);
  }
  const recognizedLegacy = typeof fm.source === "string" || portableDate(fm.created) !== null;
  return { fm, status: recognizedLegacy ? "legacy" : "invalid", issues };
}

export async function inventorySources(input: {
  vault: string;
  today?: string;
}): Promise<{ exitCode: number; output?: SourceInventoryOutput; error?: unknown }> {
  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: 9, error: scan };
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const legacyPages = scan.data.allMarkdown.filter((page) => page.relPath.startsWith("_archive/raw/"));
  const pages = [...scan.data.raw, ...legacyPages].filter((page) => supportedSource(page.relPath));
  const availablePaths = pages.map((page) => page.relPath);
  const typedPaths = new Set(scan.data.typedKnowledge.map(page => page.relPath));
  const otherPages = scan.data.allMarkdown.filter((page) =>
    !typedPaths.has(page.relPath)
    && !page.relPath.startsWith("raw/")
    && !page.relPath.startsWith("_archive/")
  );
  const diagnostics: SourceLifecycleDiagnostic[] = [];
  const logEvents = await readLogEvents(input.vault);
  const relocationsResult = logEvents.ok ? projectSourceRelocations(logEvents.data) : logEvents;
  const relocationProjection = buildSourceRelocationProjection(relocationsResult.ok ? relocationsResult.data : []);
  const historicalByCurrent = new Map<string, string[]>();
  for (const [historical, current] of relocationProjection) {
    const paths = historicalByCurrent.get(current) ?? [];
    paths.push(historical);
    historicalByCurrent.set(current, paths);
  }
  for (const paths of historicalByCurrent.values()) paths.sort();
  const refs = await buildSourceReferenceIndex({
    typedPages: scan.data.typedKnowledge,
    otherPages,
    availableRawPaths: availablePaths,
    relocationProjection,
  });
  const dispositionsResult = logEvents.ok ? projectSourceDispositions(logEvents.data) : logEvents;
  const dispositions = dispositionsResult.ok ? dispositionsResult.data : [];
  const latestDispositionByPath = new Map<string, SourceDisposition>();
  for (const disposition of dispositions) latestDispositionByPath.set(disposition.raw_path, disposition);
  const dispositionReadError = dispositionsResult.ok ? null : dispositionsResult;
  const items: SourceLifecycleItem[] = [];

  if (!relocationsResult.ok) {
    diagnostics.push({ raw_path: "meta/log-events", code: "source_relocation_invalid", message: JSON.stringify(relocationsResult) });
  }
  for (const unresolved of refs.unresolved) {
    diagnostics.push({
      raw_path: unresolved.sourcePath,
      code: "source_reference_unresolved",
      message: `${unresolved.kind} reference does not resolve: ${unresolved.target}`,
    });
  }

  for (const page of pages) {
    let text: string;
    try {
      text = await readPage(page);
    } catch (error) {
      diagnostics.push({ raw_path: page.relPath, code: "source_unreadable", message: String(error) });
      continue;
    }
    const classification = classifySchema(extractFrontmatter(text));
    const date = captureDate(page.relPath, classification.fm);
    const referencedBy = refs.integratedBy.get(page.relPath) ?? [];
    const elsewhere = refs.referencedElsewhereBy.get(page.relPath) ?? [];
    const projectedDisposition = effectiveSourceDisposition({
      dispositions: latestDispositionByPath.has(page.relPath) ? [latestDispositionByPath.get(page.relPath)!] : [],
      rawPath: page.relPath,
      bodySha256: bodySha256(text),
      completeSha256: completeSha256(text),
      today,
    });
    const sourceUrl = typeof classification.fm.source_url === "string"
      ? classification.fm.source_url
      : typeof classification.fm.source === "string"
        ? classification.fm.source
        : null;
    if (classification.status === "invalid") {
      diagnostics.push({ raw_path: page.relPath, code: "source_schema_invalid", message: classification.issues.join("; ") });
    }
    const storage = storageStatus(page.relPath);
    items.push({
      raw_path: page.relPath,
      current_raw_path: page.relPath,
      historical_raw_paths: historicalByCurrent.get(page.relPath) ?? [],
      storage_status: storage,
      title: titleFor(page.relPath, classification.fm),
      source_url: sourceUrl,
      captured: date.captured,
      date_source: date.source,
      age_bucket: ageBucket(date.captured, today),
      capture_channel: channel(classification.fm, classification.status),
      lifecycle_status: referencedBy.length > 0
        ? "integrated"
        : storage === "duplicate"
          ? "duplicate"
          : projectedDisposition.lifecycle,
      schema_status: classification.status,
      schema_issues: classification.issues,
      reference_count: referencedBy.length,
      referenced_by: referencedBy,
      referenced_elsewhere: elsewhere,
      ...(projectedDisposition.disposition ? { effective_disposition: projectedDisposition.disposition } : {}),
      ...(projectedDisposition.identityMismatch ? { disposition_identity_mismatch: true } : {}),
    });
  }

  if (dispositionReadError) {
    diagnostics.push({ raw_path: "meta/log-events", code: "source_disposition_invalid", message: JSON.stringify(dispositionReadError) });
  }

  items.sort((a, b) => (b.captured ?? "").localeCompare(a.captured ?? "") || a.raw_path.localeCompare(b.raw_path));
  return { exitCode: 0, output: { items, diagnostics } };
}

export function sourceMatches(item: SourceLifecycleItem, text: string): boolean {
  const terms = text.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${item.title}\n${item.source_url ?? ""}\n${item.raw_path}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
