import {
  COMMUNITY_MAX_FETCHES_PER_SOURCE,
  COMMUNITY_MAX_ITEMS_PER_SOURCE,
  type CommunityReference,
} from "./discovery-contracts.js";
import {
  capCommunityReferencesPerRepository,
  dedupeCommunityReferences,
  extractCanonicalRepositoryUrls,
  makeCommunityReference,
} from "./discovery-community-normalize.js";
import type { ResearchConfig } from "./config.js";
import { err, ok, type Result } from "./types.js";

/**
 * Bounded, injectable community-source adapters plus the source dispatcher
 * for the recall-first discovery ladder. All network access flows through
 * the injected CommunityFetchClient; no credentials, prompts, environment
 * values, or page bodies are ever retained. Source failures, unknown
 * adapters, and malformed payloads become structured per-source warnings
 * and never fail the run for other sources.
 */

export interface CommunityFetchClient {
  /** Fetch one public JSON document. Structured error on failure. */
  fetchJson(url: string): Promise<Result<unknown>>;
}

export interface CommunityAdapterFetchInput {
  /** Maximum items this source may normalize per run. */
  maxItems: number;
  /** Maximum fetch calls this source may make per run. */
  maxRequests: number;
}

export interface CommunityAdapterFetchOutput {
  references: CommunityReference[];
  /** Structured per-item warnings; never fatal to the source. */
  warnings: string[];
  requestsUsed: number;
}

export interface CommunitySourceAdapter {
  readonly sourceId: string;
  fetchReferences(input: CommunityAdapterFetchInput): Promise<Result<CommunityAdapterFetchOutput>>;
}

const HACKER_NEWS_FIREBASE_BASE = "https://hacker-news.firebaseio.com/v0";
const HACKER_NEWS_ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search";
const HUGGING_FACE_TRENDING_URL = "https://huggingface.co/api/trending";
/**
 * Documented model-card metadata fields scanned for outbound GitHub links.
 * The Hugging Face model URL itself is never treated as a repository link.
 */
const HUGGING_FACE_CARD_LINK_FIELDS = ["github", "github_repo", "repository", "homepage", "code", "paper"];

/**
 * Hacker News adapter: Firebase top-stories API with a best-effort Algolia
 * fallback. Bounded by maxItems/maxRequests; normalizes only GitHub-linked
 * items; score/comment/publication metadata survives only inside the short
 * English review summary, never the full story text.
 */
export function createHackerNewsAdapter(client: CommunityFetchClient): CommunitySourceAdapter {
  return {
    sourceId: "hacker_news",
    async fetchReferences(input) {
      const warnings: string[] = [];
      const references: CommunityReference[] = [];
      let requestsUsed = 0;

      const topStories = await client.fetchJson(`${HACKER_NEWS_FIREBASE_BASE}/topstories.json`);
      requestsUsed += 1;
      if (topStories.ok && Array.isArray(topStories.data)) {
        const ids = topStories.data
          .filter((id): id is number => typeof id === "number" && Number.isInteger(id))
          .slice(0, input.maxItems);
        for (const id of ids) {
          if (requestsUsed >= input.maxRequests) break;
          const itemResult = await client.fetchJson(`${HACKER_NEWS_FIREBASE_BASE}/item/${id}.json`);
          requestsUsed += 1;
          if (!itemResult.ok) {
            warnings.push(`failed to fetch item ${id}: ${String(itemResult.detail ?? itemResult.error)}`);
            continue;
          }
          references.push(...normalizeHackerNewsItem(itemResult.data, id, warnings));
        }
        return ok({ references, warnings, requestsUsed });
      }

      warnings.push(
        topStories.ok
          ? "firebase top stories payload was not an array; fell back to the Algolia endpoint"
          : `firebase top stories unavailable (${String(topStories.detail ?? topStories.error)}); fell back to the Algolia endpoint`
      );
      if (requestsUsed >= input.maxRequests) {
        return err("HN_FETCH_FAILED", "no request budget left for the Algolia fallback");
      }
      const algolia = await client.fetchJson(`${HACKER_NEWS_ALGOLIA_SEARCH}?tags=story&hitsPerPage=${input.maxItems}`);
      requestsUsed += 1;
      if (!algolia.ok) {
        return err("HN_FETCH_FAILED", `both endpoints failed; last error: ${String(algolia.detail ?? algolia.error)}`);
      }
      const payload = algolia.data;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return err("HN_PAYLOAD_INVALID", "Algolia search payload was not an object");
      }
      const hits = (payload as Record<string, unknown>).hits;
      if (!Array.isArray(hits)) {
        return err("HN_PAYLOAD_INVALID", "Algolia search payload did not contain a hits array");
      }
      for (const hit of hits.slice(0, input.maxItems)) {
        references.push(...normalizeAlgoliaHit(hit, warnings));
      }
      return ok({ references, warnings, requestsUsed });
    },
  };
}

function normalizeHackerNewsItem(value: unknown, fallbackId: number, warnings: string[]): CommunityReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`malformed item ${fallbackId}`);
    return [];
  }
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "number" && Number.isInteger(item.id) ? item.id : fallbackId;
  const canonicalUrls = extractCanonicalRepositoryUrls({ url: item.url });
  if (canonicalUrls.length === 0) return [];

  const parts: string[] = [];
  if (typeof item.score === "number" && Number.isFinite(item.score)) parts.push(`score ${item.score}`);
  if (typeof item.descendants === "number" && Number.isFinite(item.descendants)) {
    parts.push(`${item.descendants} comments`);
  }
  if (typeof item.by === "string" && item.by.trim() !== "") parts.push(`by ${item.by}`);
  const englishSummary = parts.length > 0 ? `HN story, ${parts.join(", ")}` : "HN story";
  const observedAt =
    typeof item.time === "number" && Number.isFinite(item.time) && item.time > 0
      ? new Date(item.time * 1000).toISOString()
      : undefined;

  return referencesForCanonicalUrls(canonicalUrls, "hacker_news", `https://news.ycombinator.com/item?id=${id}`, {
    title: typeof item.title === "string" ? item.title : undefined,
    englishSummary,
    observedAt,
    itemLabel: `item ${id}`,
    warnings,
  });
}

function normalizeAlgoliaHit(value: unknown, warnings: string[]): CommunityReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("malformed Algolia hit");
    return [];
  }
  const hit = value as Record<string, unknown>;
  const objectId = typeof hit.objectID === "string" && hit.objectID.trim() !== "" ? hit.objectID : "unknown";
  const canonicalUrls = extractCanonicalRepositoryUrls({ url: hit.url });
  if (canonicalUrls.length === 0) return [];

  const parts: string[] = [];
  if (typeof hit.points === "number" && Number.isFinite(hit.points)) parts.push(`score ${hit.points}`);
  if (typeof hit.num_comments === "number" && Number.isFinite(hit.num_comments)) {
    parts.push(`${hit.num_comments} comments`);
  }
  const englishSummary = parts.length > 0 ? `HN story, ${parts.join(", ")}` : "HN story";

  return referencesForCanonicalUrls(canonicalUrls, "hacker_news", `https://news.ycombinator.com/item?id=${objectId}`, {
    title: typeof hit.title === "string" ? hit.title : undefined,
    englishSummary,
    observedAt: typeof hit.created_at === "string" ? hit.created_at : undefined,
    itemLabel: `Algolia hit ${objectId}`,
    warnings,
  });
}

/**
 * Hugging Face adapter: public trending-model API through the injected
 * client. Bounded result count; strict GitHub links are extracted only
 * from the documented card link fields. A Hugging Face model URL alone
 * never becomes a repository reference.
 */
export function createHuggingFaceAdapter(client: CommunityFetchClient): CommunitySourceAdapter {
  return {
    sourceId: "hugging_face",
    async fetchReferences(input) {
      const result = await client.fetchJson(HUGGING_FACE_TRENDING_URL);
      if (!result.ok) return result;
      const payload = result.data;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return err("HF_TRENDING_PAYLOAD_INVALID", "expected an object with a trending array");
      }
      const trending = (payload as Record<string, unknown>).trending;
      if (!Array.isArray(trending)) {
        return err("HF_TRENDING_PAYLOAD_INVALID", "expected trending to be an array");
      }
      const warnings: string[] = [];
      const references: CommunityReference[] = [];
      for (const entry of trending.slice(0, input.maxItems)) {
        references.push(...normalizeHuggingFaceEntry(entry, warnings));
      }
      return ok({ references, warnings, requestsUsed: 1 });
    },
  };
}

function normalizeHuggingFaceEntry(value: unknown, warnings: string[]): CommunityReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("malformed trending entry");
    return [];
  }
  const entry = value as Record<string, unknown>;
  const repoData = entry.repoData;
  if (repoData === null || typeof repoData !== "object" || Array.isArray(repoData)) {
    warnings.push("trending entry without repoData");
    return [];
  }
  const data = repoData as Record<string, unknown>;
  const modelId = typeof data.id === "string" && data.id.trim() !== "" ? data.id : undefined;
  if (!modelId) {
    warnings.push("trending entry without a model id");
    return [];
  }
  const links: string[] = [];
  const cardData = data.cardData;
  if (cardData !== null && typeof cardData === "object" && !Array.isArray(cardData)) {
    for (const field of HUGGING_FACE_CARD_LINK_FIELDS) {
      const value = (cardData as Record<string, unknown>)[field];
      if (typeof value === "string") links.push(value);
    }
  }
  const canonicalUrls = extractCanonicalRepositoryUrls({ links });
  if (canonicalUrls.length === 0) return [];

  const likes = typeof data.likes === "number" && Number.isFinite(data.likes) ? data.likes : undefined;
  const englishSummary = `Trending on Hugging Face${likes !== undefined ? `, ${likes} likes` : ""}`;

  return referencesForCanonicalUrls(canonicalUrls, "hugging_face", `https://huggingface.co/${modelId}`, {
    title: modelId,
    englishSummary,
    itemLabel: `model ${modelId}`,
    warnings,
  });
}

/**
 * Generic registered JSON community adapter (for example a China-region
 * public community feed keyed by its configured source ID). Consumes
 * public JSON items through the injected client; preserves original-
 * language title/excerpt/language and emits a conservative bounded English
 * review summary that never pretends to translate.
 */
export function createJsonCommunityAdapter(
  sourceId: string,
  feedUrl: string,
  client: CommunityFetchClient
): CommunitySourceAdapter {
  return {
    sourceId,
    async fetchReferences(input) {
      const result = await client.fetchJson(feedUrl);
      if (!result.ok) return result;
      const items = extractJsonItems(result.data);
      if (!items.ok) return items;
      const warnings: string[] = [];
      const references: CommunityReference[] = [];
      for (const item of items.data.slice(0, input.maxItems)) {
        references.push(...normalizeJsonCommunityItem(sourceId, item, warnings));
      }
      return ok({ references, warnings, requestsUsed: 1 });
    },
  };
}

function extractJsonItems(payload: unknown): Result<unknown[]> {
  if (Array.isArray(payload)) return ok(payload);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const items = (payload as Record<string, unknown>).items;
    if (Array.isArray(items)) return ok(items);
  }
  return err("COMMUNITY_JSON_PAYLOAD_INVALID", "expected a JSON array or an object with an items array");
}

function normalizeJsonCommunityItem(sourceId: string, value: unknown, warnings: string[]): CommunityReference[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("malformed item");
    return [];
  }
  const item = value as Record<string, unknown>;
  const sourceUrl = typeof item.url === "string" ? item.url : undefined;
  if (!sourceUrl) {
    warnings.push("item without a public url skipped");
    return [];
  }
  const canonicalUrls = extractCanonicalRepositoryUrls({ links: item.links });
  if (canonicalUrls.length === 0) return [];

  const language = typeof item.language === "string" ? item.language : undefined;
  const title = typeof item.title === "string" ? item.title : undefined;
  const excerpt = typeof item.excerpt === "string" ? item.excerpt : undefined;
  const supplied = typeof item.english_summary === "string" ? item.english_summary.trim() : "";
  const englishSummary =
    supplied !== ""
      ? supplied
      : `Community observation${language ? ` in ${language}` : ""}${title ? `: "${title}"` : ""}; no source-provided English summary`;
  const observedAt = typeof item.published_at === "string" ? item.published_at : undefined;

  return referencesForCanonicalUrls(canonicalUrls, sourceId, sourceUrl, {
    language,
    title,
    excerpt,
    englishSummary,
    observedAt,
    itemLabel: `item ${typeof item.id === "string" ? item.id : "?"}`,
    warnings,
  });
}

interface ReferenceFields {
  language?: string;
  title?: string;
  excerpt?: string;
  englishSummary: string;
  observedAt?: string;
  itemLabel: string;
  warnings: string[];
}

function referencesForCanonicalUrls(
  canonicalUrls: string[],
  sourceId: string,
  sourceUrl: string,
  fields: ReferenceFields
): CommunityReference[] {
  const references: CommunityReference[] = [];
  for (const canonicalUrl of canonicalUrls) {
    const reference = makeCommunityReference({
      canonicalUrl,
      sourceId,
      sourceUrl,
      language: fields.language,
      title: fields.title,
      excerpt: fields.excerpt,
      englishSummary: fields.englishSummary,
      observedAt: fields.observedAt,
    });
    if (!reference.ok) {
      fields.warnings.push(`${fields.itemLabel} skipped: ${String(reference.detail ?? reference.error)}`);
      continue;
    }
    references.push(reference.data);
  }
  return references;
}

export interface CommunityCollectionOptions {
  /** Injected JSON fetch client; the only network path in this layer. */
  fetchJson: CommunityFetchClient;
  /** Extra registered adapters keyed by configured community source ID. */
  adapters?: Readonly<Record<string, CommunitySourceAdapter>>;
}

export interface CommunityCollectionOutput {
  /** Deduplicated, per-repository capped, deterministically ordered references. */
  references: CommunityReference[];
  /** Structured per-source and per-item warnings; never fatal. */
  warnings: string[];
  requestsUsed: number;
  sources: {
    attempted: string[];
    skipped: string[];
    unknown: string[];
  };
}

/**
 * Collect bounded community references from all enabled registered
 * community sources. Fails closed with DISCOVERY_DISABLED before any other
 * discovery setting is read; an unknown adapter, a failed source fetch, an
 * invalid payload, or a malformed item becomes a structured warning while
 * other configured sources continue.
 */
export async function collectCommunityReferences(
  config: ResearchConfig,
  options: CommunityCollectionOptions
): Promise<Result<CommunityCollectionOutput>> {
  if (!config.discovery.enabled) {
    return err("DISCOVERY_DISABLED", "discovery is disabled in configuration; refusing to collect");
  }

  const builtin: Record<string, CommunitySourceAdapter> = {
    hacker_news: createHackerNewsAdapter(options.fetchJson),
    hugging_face: createHuggingFaceAdapter(options.fetchJson),
    ...options.adapters,
  };
  const warnings: string[] = [];
  const references: CommunityReference[] = [];
  const sources = { attempted: [] as string[], skipped: [] as string[], unknown: [] as string[] };
  let requestsUsed = 0;

  for (const source of config.discovery.communitySources) {
    if (!source.enabled) {
      sources.skipped.push(source.id);
      continue;
    }
    const adapter = builtin[source.id];
    if (!adapter) {
      sources.unknown.push(source.id);
      warnings.push(`community source ${source.id} is not registered; skipping`);
      continue;
    }
    sources.attempted.push(source.id);
    const result = await adapter.fetchReferences({
      maxItems: COMMUNITY_MAX_ITEMS_PER_SOURCE,
      maxRequests: COMMUNITY_MAX_FETCHES_PER_SOURCE,
    });
    if (!result.ok) {
      warnings.push(`community source ${source.id} failed: ${String(result.detail ?? result.error)}`);
      continue;
    }
    requestsUsed += result.data.requestsUsed;
    for (const warning of result.data.warnings) warnings.push(`community source ${source.id}: ${warning}`);
    references.push(...result.data.references);
  }

  return ok({
    references: capCommunityReferencesPerRepository(dedupeCommunityReferences(references)),
    warnings,
    requestsUsed,
    sources,
  });
}
