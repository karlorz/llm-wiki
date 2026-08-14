import {
  canonicalizeDiscoveryRepositoryUrl,
  DISCOVERY_ATTENTION_EVIDENCE_MAX,
  DISCOVERY_ATTENTION_EXCERPT_MAX,
  type CommunityReference,
  type DiscoveryAttentionEvidence,
  type DiscoveryCandidate,
} from "./discovery-contracts.js";
import { err, ok, type Result } from "./types.js";

/**
 * Pure extraction/normalization and merge seams for the community
 * discovery layer. No network, no config access: bounded external fields
 * in, strictly canonical references/evidence out.
 */

/** Maximum length of an external string scanned for canonical links. */
const COMMUNITY_SCAN_VALUE_MAX = 500;
/** Maximum external candidate strings scanned per item. */
const COMMUNITY_SCAN_FIELDS_MAX = 20;
/** evidenceQualityInput gained per matched direct canonical reference. */
const COMMUNITY_EVIDENCE_QUALITY_PER_REFERENCE = 5;

/** Cap one retained text field to the shared attention excerpt bound. */
export function truncateDiscoveryText(text: string, max = DISCOVERY_ATTENTION_EXCERPT_MAX): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

export interface ExternalItemFields {
  /** The item's own public URL; may be a direct GitHub repository link. */
  url?: unknown;
  /** Explicitly supplied outbound links/metadata; a string or array of strings. */
  links?: unknown;
}

/**
 * Pure extraction/normalization seam: bounded external item fields in,
 * strictly canonical GitHub repository URLs out. Accepts only direct
 * repository links and explicitly supplied outbound links; rejects profile,
 * issue/pull/tree/blob, non-GitHub, malformed, and query/fragment/port
 * qualified URLs, and arbitrary untrusted repository claims without a
 * canonical link. Deduplicates deterministically in first-seen order and
 * drops over-long scan values instead of truncating them into a wrong repo.
 */
export function extractCanonicalRepositoryUrls(fields: ExternalItemFields): string[] {
  const candidates: string[] = [];
  const push = (value: unknown): void => {
    if (candidates.length >= COMMUNITY_SCAN_FIELDS_MAX) return;
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed === "" || trimmed.length > COMMUNITY_SCAN_VALUE_MAX) return;
    candidates.push(trimmed);
  };
  push(fields.url);
  if (Array.isArray(fields.links)) {
    for (const link of fields.links) push(link);
  } else {
    push(fields.links);
  }

  const canonical: string[] = [];
  for (const candidate of candidates) {
    const result = canonicalizeDiscoveryRepositoryUrl(candidate);
    if (result.ok && !canonical.includes(result.data)) canonical.push(result.data);
  }
  return canonical;
}

export interface CommunityReferenceInput {
  canonicalUrl: string;
  sourceId: string;
  sourceUrl: string;
  language?: string;
  title?: string;
  excerpt?: string;
  englishSummary?: string;
  observedAt?: string;
}

/**
 * Build one bounded community reference: re-validates the strict canonical
 * repository URL, requires a public http(s) source URL without credentials
 * within the shared retained text bound (overlong or malformed inputs are
 * rejected, never truncated into a potentially unrelated URL), caps every
 * retained text field to DISCOVERY_ATTENTION_EXCERPT_MAX, keeps only valid
 * observation timestamps, and falls back to a conservative generic English
 * summary when none was supplied. Never retains body text, headers,
 * prompts, environment values, or secrets.
 */
export function makeCommunityReference(input: CommunityReferenceInput): Result<CommunityReference> {
  const canonical = canonicalizeDiscoveryRepositoryUrl(input.canonicalUrl);
  if (!canonical.ok) return err("COMMUNITY_INVALID_CANONICAL_URL", canonical.detail ?? canonical.error);

  const sourceUrl = input.sourceUrl.trim();
  if (sourceUrl.length > DISCOVERY_ATTENTION_EXCERPT_MAX) {
    return err(
      "COMMUNITY_INVALID_SOURCE_URL",
      `expected a public http(s) source URL of at most ${DISCOVERY_ATTENTION_EXCERPT_MAX} characters, got ${sourceUrl.length}`
    );
  }
  // Never echo the raw source URL: `@` in the authority of a valid http(s)
  // URL is userinfo, and any `@` in a value that is not a valid http(s) URL
  // at all is treated as credential-bearing. Both are rejected with a
  // credential-safe detail; valid http(s) URLs with `@` only in the path
  // stay accepted, and every other malformed value is rejected with a
  // generic detail that never echoes the raw input (even short
  // credential-free values could carry a secret).
  const isPublicHttpUrl = /^https?:\/\/\S+$/.test(sourceUrl);
  const hasCredentialInAuthority = /^https?:\/\/[^/\s]*@/.test(sourceUrl);
  if (/@/.test(sourceUrl) && (!isPublicHttpUrl || hasCredentialInAuthority)) {
    return err("COMMUNITY_INVALID_SOURCE_URL", "expected a public http(s) source URL without credentials");
  }
  if (!isPublicHttpUrl) {
    return err("COMMUNITY_INVALID_SOURCE_URL", "expected a public http(s) source URL");
  }

  const reference: CommunityReference = {
    canonicalUrl: canonical.data,
    sourceId: input.sourceId,
    sourceUrl,
    englishSummary: truncateDiscoveryText(input.englishSummary ?? "") || "Community observation",
  };
  const language = truncateDiscoveryText(input.language ?? "");
  if (language) reference.language = language;
  const title = truncateDiscoveryText(input.title ?? "");
  if (title) reference.title = title;
  const excerpt = truncateDiscoveryText(input.excerpt ?? "");
  if (excerpt) reference.excerpt = excerpt;
  if (typeof input.observedAt === "string" && Number.isFinite(Date.parse(input.observedAt))) {
    reference.observedAt = input.observedAt;
  }
  return ok(reference);
}

/** Deduplicate references on canonical repository + source ID + source URL. */
export function dedupeCommunityReferences(references: CommunityReference[]): CommunityReference[] {
  const seen = new Set<string>();
  const deduped: CommunityReference[] = [];
  for (const reference of references) {
    const key = `${reference.canonicalUrl}|${reference.sourceId}|${reference.sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}

/**
 * Deterministically order references (canonical URL, source ID, source URL)
 * and retain at most DISCOVERY_ATTENTION_EVIDENCE_MAX per canonical
 * repository.
 */
export function capCommunityReferencesPerRepository(references: CommunityReference[]): CommunityReference[] {
  const sorted = [...references].sort(
    (a, b) =>
      a.canonicalUrl.localeCompare(b.canonicalUrl) ||
      a.sourceId.localeCompare(b.sourceId) ||
      a.sourceUrl.localeCompare(b.sourceUrl)
  );
  const counts = new Map<string, number>();
  const bounded: CommunityReference[] = [];
  for (const reference of sorted) {
    const count = counts.get(reference.canonicalUrl) ?? 0;
    if (count >= DISCOVERY_ATTENTION_EVIDENCE_MAX) continue;
    counts.set(reference.canonicalUrl, count + 1);
    bounded.push(reference);
  }
  return bounded;
}

export interface MergeCommunityReferencesInput {
  candidate: DiscoveryCandidate;
  references: CommunityReference[];
  /** Enabled community source IDs permitted to enter provenance/evidence. */
  validSourceIds: string[];
}

/**
 * Pure merge seam: attach bounded community references to an existing
 * candidate only when the canonical repository URL matches and the source
 * ID is valid. Preserves the candidate's GitHub identity and public facts;
 * appends deduplicated bounded attention evidence; adds only valid source
 * IDs to provenance; increases evidenceQualityInput by a fixed small
 * amount per matched direct reference (capped at 100). Never creates a
 * candidate from community items alone and never changes disposition,
 * alert, promotion eligibility, score, or reasons.
 */
export function mergeCommunityReferences(input: MergeCommunityReferencesInput): DiscoveryCandidate {
  const candidate = input.candidate;
  const seen = new Set(candidate.attentionEvidence.map((evidence) => `${evidence.sourceId}|${evidence.url}`));
  const evidence = [...candidate.attentionEvidence];
  const addedSourceIds: string[] = [];
  let matched = 0;

  for (const reference of input.references) {
    if (reference.canonicalUrl !== candidate.canonicalUrl) continue;
    if (!input.validSourceIds.includes(reference.sourceId)) continue;
    const key = `${reference.sourceId}|${reference.sourceUrl}`;
    if (seen.has(key)) continue;
    if (evidence.length >= DISCOVERY_ATTENTION_EVIDENCE_MAX) break;
    seen.add(key);
    matched += 1;
    evidence.push(toAttentionEvidence(reference));
    if (!addedSourceIds.includes(reference.sourceId)) addedSourceIds.push(reference.sourceId);
  }

  return {
    ...candidate,
    sourceIds: [...candidate.sourceIds, ...addedSourceIds],
    attentionEvidence: evidence,
    evidenceQualityInput: Math.min(
      100,
      candidate.evidenceQualityInput + matched * COMMUNITY_EVIDENCE_QUALITY_PER_REFERENCE
    ),
  };
}

function toAttentionEvidence(reference: CommunityReference): DiscoveryAttentionEvidence {
  const evidence: DiscoveryAttentionEvidence = { sourceId: reference.sourceId, url: reference.sourceUrl };
  if (reference.language) evidence.language = reference.language;
  if (reference.title) evidence.title = reference.title;
  if (reference.excerpt) evidence.excerpt = reference.excerpt;
  if (reference.englishSummary) evidence.englishSummary = reference.englishSummary;
  return evidence;
}
