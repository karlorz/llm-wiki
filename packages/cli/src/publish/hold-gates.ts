import { join } from "node:path";
import {
  detectSchema,
  TypedKnowledgeSchema,
  MetaSchema,
  err,
  ok,
  type Result,
} from "@skillwiki/shared";
import { extractFrontmatter, splitFrontmatter } from "../parsers/frontmatter.js";
import { extractBodyWikilinks } from "../parsers/wikilinks.js";
import { extractCitationMarkers } from "../parsers/citations.js";
import { buildWikilinkResolver } from "../utils/wikilink-resolver.js";
import { scanVault, type VaultScan } from "../utils/vault.js";
import { operationId } from "../utils/operation-id.js";
import { writeLogEvent } from "../utils/log-events.js";
import type { PreparedPublicationCore } from "./types.js";

export type PublicationHoldReason =
  | "schema-invalid"
  | "broken-wikilink"
  | "citation-marker-missing";

export interface HoldGateEvaluation {
  held: boolean;
  hold_reasons: PublicationHoldReason[];
}

/**
 * Gate 1: schema-invalid
 * Evaluates whether draft frontmatter and body conform to the detected typed-page schema.
 */
export function evaluateSchemaGate(content: string, target: string, publisherKind: "page" | "project-page"): boolean {
  const frontmatter = extractFrontmatter(content);
  if (!frontmatter.ok) return false;

  const detected = detectSchema(frontmatter.data);
  if (publisherKind === "project-page") {
    if (detected.schema !== "typed-knowledge") return false;
    const parsed = TypedKnowledgeSchema.safeParse(frontmatter.data);
    if (!parsed.success) return false;
    if (parsed.data.type !== "concept") return false;
    if (parsed.data.provenance !== "project" && parsed.data.provenance !== "mixed") return false;
    return true;
  }

  // publisherKind === "page"
  if (detected.schema === "typed-knowledge") {
    const parsed = TypedKnowledgeSchema.safeParse(frontmatter.data);
    if (!parsed.success) return false;
    const typeDir: Record<string, string> = {
      entity: "entities",
      concept: "concepts",
      comparison: "comparisons",
      query: "queries",
      meta: "meta",
    };
    const expectedDir = typeDir[parsed.data.type];
    if (!expectedDir || !target.startsWith(`${expectedDir}/`)) return false;
    return true;
  }

  if (detected.schema === "meta") {
    const parsed = MetaSchema.safeParse(frontmatter.data);
    if (!parsed.success) return false;
    if (!target.startsWith("meta/")) return false;
    return true;
  }

  return false;
}

/**
 * Gate 2: broken-wikilink
 * Resolves all wikilinks in draft body against current vault via wikilinkResolver.
 * The draft's own target counts as resolvable (R11): a new page linking to
 * itself is not broken, since the target exists once published.
 */
export function evaluateBrokenWikilinkGate(
  body: string,
  scan: VaultScan,
  ownTarget: string,
): boolean {
  const draftPage = { absPath: join(scan.root, ownTarget), relPath: ownTarget };
  const resolver = buildWikilinkResolver([...scan.allMarkdown, draftPage]);
  const wikilinks = extractBodyWikilinks(body);
  for (const link of wikilinks) {
    const res = resolver.resolve(link);
    if (!res.path) {
      return false; // has broken wikilink
    }
  }
  return true;
}

/**
 * Gate 3: citation-marker-missing
 * If draft declares non-empty sources in frontmatter (e.g. raw/... sources or sourced claims),
 * the body must contain at least one ^[ citation marker.
 * Project architecture pages cite project specs via sources frontmatter without requiring raw ^[ markers.
 */
export function evaluateCitationMarkerGate(content: string, body: string, publisherKind: "page" | "project-page"): boolean {
  if (publisherKind === "project-page") return true;
  const fm = extractFrontmatter(content);
  if (!fm.ok) return true; // schema-invalid gate handles bad frontmatter
  const sources = fm.data.sources;
  const hasDeclaredSources = (Array.isArray(sources) && sources.length > 0) || (typeof sources === "string" && sources.trim().length > 0);
  if (!hasDeclaredSources) return true;

  // Search body for ^[ citation markers (including ^[raw/...])
  const markers = extractCitationMarkers(body);
  return markers.length > 0 || /\^\[[^\]]+\]/.test(body);
}

/**
 * Evaluate the configured publication hold gates against prepared draft content.
 * Sensitive draft content is NOT a hold gate: it is hard-rejected upstream in
 * prepareTypedPage (SENSITIVE_CONTENT_DETECTED), a strictly stronger response
 * that keeps credentials out of any review-accept path (R10).
 */
export async function evaluatePublicationHoldGates(input: {
  prepared: PreparedPublicationCore;
  vault: string;
  publisherKind: "page" | "project-page";
  scan?: VaultScan;
}): Promise<HoldGateEvaluation> {
  const hold_reasons: PublicationHoldReason[] = [];
  const { content, target } = input.prepared;

  // 1. schema-invalid
  const schemaValid = evaluateSchemaGate(content, target, input.publisherKind);
  if (!schemaValid) {
    hold_reasons.push("schema-invalid");
  }

  const split = splitFrontmatter(content);
  const body = split.ok ? split.data.body : content;

  // 2. broken-wikilink
  const scanResult = input.scan ? { ok: true, data: input.scan } : await scanVault(input.vault);
  if (scanResult.ok) {
    const wikilinksValid = evaluateBrokenWikilinkGate(body, scanResult.data, target);
    if (!wikilinksValid) {
      hold_reasons.push("broken-wikilink");
    }
  }

  // 3. citation-marker-missing
  const citationValid = evaluateCitationMarkerGate(content, body, input.publisherKind);
  if (!citationValid) {
    hold_reasons.push("citation-marker-missing");
  }

  return {
    held: hold_reasons.length > 0,
    hold_reasons,
  };
}

/**
 * Emit a source-review hold event into meta/log-events for a held publication.
 */
export async function emitPublicationHoldReviewEvent(input: {
  vault: string;
  prepared: PreparedPublicationCore;
  holdReasons: PublicationHoldReason[];
  occurredAt?: string;
  hostId?: string;
  actor?: string;
}): Promise<Result<{ event_path: string; operation_id: string }>> {
  const occurredAt = input.occurredAt ?? `${input.prepared.date}T00:00:00.000Z`;
  const hostId = input.hostId ?? "standalone";
  const actor = input.actor ?? "skillwiki-cli";

  const turnId = operationId("publication-hold-turn", [
    input.prepared.target,
    input.prepared.draftSha256,
    occurredAt,
  ]);

  const reviewOpId = operationId("source-review-open", [
    input.prepared.target,
    turnId,
    occurredAt,
  ]);

  const reason = `Publication held for review: ${input.holdReasons.join(", ")}`;

  const eventResult = await writeLogEvent(input.vault, {
    schema: "skillwiki-log-event/v1",
    operation_id: reviewOpId,
    occurred_at: occurredAt,
    host_id: hostId,
    actor,
    kind: "source-review",
    target: input.prepared.target,
    note: reason,
    metadata: {
      raw_path: input.prepared.target,
      complete_sha256: input.prepared.draftSha256,
      turn_id: turnId,
      status: "open",
      typed_paths: [input.prepared.target],
      reason,
      hold_reasons: [...input.holdReasons],
    },
  });

  if (!eventResult.ok) return eventResult;
  return {
    ok: true,
    data: {
      event_path: eventResult.data.path,
      operation_id: reviewOpId,
    },
  };
}
