import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISCOVERY_ATTENTION_EVIDENCE_MAX,
  DISCOVERY_ATTENTION_EXCERPT_MAX,
  type DiscoveryAttentionEvidence,
  type DiscoveryCandidate,
  type DiscoverySnapshot,
} from "./discovery-contracts.js";
import { err, ok, type Result } from "./types.js";

/**
 * Deterministic JSON snapshot persistence for discovery observations under a
 * caller-provided base directory. Persists only compact candidate facts,
 * score/delta fields, source IDs/URLs, alert/status/reasons, and the run
 * timestamp; never README bodies, page bodies, prompts, env vars, tokens, or
 * secrets. Filesystem writes are deliberately not wired into vault/output
 * allowlists; callers always pass a temporary or dedicated base directory.
 */

export interface DiscoveryHistoryObservation {
  /** Snapshot date, YYYY-MM-DD (UTC). */
  date: string;
  stargazersCount: number;
  forksCount: number;
}

export interface DiscoveryHistory {
  observationsByUrl: Map<string, DiscoveryHistoryObservation[]>;
  /** Human-readable warnings for malformed or skipped snapshot files/entries. */
  warnings: string[];
}

export interface WriteDiscoverySnapshotOutput {
  datedFile: string;
  datedPath: string;
  latestPath: string;
}

export interface PruneDiscoverySnapshotsOutput {
  removed: string[];
  kept: string[];
  /** Best-effort removal failures, in deterministic file order. */
  warnings: string[];
}

const SNAPSHOT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Write one dated daily snapshot plus a latest.json pointer, both with the
 * same deterministic serialized content. The dated file name derives from
 * the snapshot's own runAt timestamp (UTC date).
 */
export function writeDiscoverySnapshot(
  dir: string,
  snapshot: DiscoverySnapshot
): Result<WriteDiscoverySnapshotOutput> {
  try {
    const runAt = new Date(snapshot.runAt);
    if (!Number.isFinite(runAt.getTime())) {
      return err("SNAPSHOT_INVALID", "snapshot runAt must be a valid ISO timestamp");
    }
    mkdirSync(dir, { recursive: true });
    const datedFile = `${dateKey(runAt)}.json`;
    const payload = serializeSnapshot(snapshot);
    const datedPath = join(dir, datedFile);
    const latestPath = join(dir, "latest.json");
    writeFileSync(datedPath, payload, "utf8");
    writeFileSync(latestPath, payload, "utf8");
    return ok({ datedFile, datedPath, latestPath });
  } catch (error) {
    return err("SNAPSHOT_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export function readDiscoverySnapshot(path: string): Result<DiscoverySnapshot> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return err("SNAPSHOT_READ_FAILED", error instanceof Error ? error.message : String(error));
  }
  return parseDiscoverySnapshot(text, path);
}

export function parseDiscoverySnapshot(text: string, source: string): Result<DiscoverySnapshot> {
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err("SNAPSHOT_INVALID", `${source}: expected an object`);
    }
    const formatVersion = (parsed as { formatVersion?: unknown }).formatVersion;
    if (formatVersion !== 1) {
      return err("SNAPSHOT_INVALID", `${source}: unsupported formatVersion ${String(formatVersion)}`);
    }
    const candidates = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates)) {
      return err("SNAPSHOT_INVALID", `${source}: candidates must be an array`);
    }
    return ok({
      formatVersion: 1,
      runAt: typeof (parsed as { runAt?: unknown }).runAt === "string" ? (parsed as { runAt: string }).runAt : "",
      retentionDays:
        typeof (parsed as { retentionDays?: unknown }).retentionDays === "number"
          ? (parsed as { retentionDays: number }).retentionDays
          : 0,
      candidates: candidates as DiscoveryCandidate[],
    });
  } catch (error) {
    return err("SNAPSHOT_INVALID", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Load dated daily snapshots within the retention window, strictly before
 * today, for delta computation. Malformed files and entries are skipped with
 * warnings; missing observations stay absent (never numeric zero).
 */
export function loadDiscoveryHistory(dir: string, now: Date, retentionDays: number): DiscoveryHistory {
  const warnings: string[] = [];
  const observationsByUrl = new Map<string, DiscoveryHistoryObservation[]>();
  const today = dateKey(now);
  const earliest = addDays(today, -retentionDays);

  for (const file of listDatedSnapshotFiles(dir)) {
    const date = file.slice(0, 10);
    if (date <= earliest || date >= today) continue;
    const result = readDiscoverySnapshot(join(dir, file));
    if (!result.ok) {
      warnings.push(`malformed snapshot ${file}: ${String(result.detail ?? result.error)}`);
      continue;
    }
    for (const entry of result.data.candidates) {
      if (!isUsableHistoryEntry(entry)) {
        warnings.push(`skipped entry without usable facts in ${file}`);
        continue;
      }
      const list = observationsByUrl.get(entry.canonicalUrl) ?? [];
      list.push({ date, stargazersCount: entry.stargazersCount, forksCount: entry.forksCount });
      observationsByUrl.set(entry.canonicalUrl, list);
    }
  }

  for (const list of observationsByUrl.values()) {
    list.sort((left, right) => left.date.localeCompare(right.date));
  }
  return { observationsByUrl, warnings };
}

/**
 * Fill 24-hour and 7-day star/fork deltas from prior observations for the
 * same canonical repository URL. First observations stay null (baseline
 * unknown); a real zero delta stays 0.
 */
export function applyDiscoveryDeltas(
  candidates: DiscoveryCandidate[],
  history: DiscoveryHistory,
  now: Date
): DiscoveryCandidate[] {
  const today = dateKey(now);
  return candidates.map((candidate) => {
    const observations = history.observationsByUrl.get(candidate.canonicalUrl) ?? [];
    const prior24h = latestOnOrBefore(observations, addDays(today, -1));
    const prior7d = latestOnOrBefore(observations, addDays(today, -7));
    return {
      ...candidate,
      starDelta24h: prior24h ? candidate.stargazersCount - prior24h.stargazersCount : null,
      starDelta7d: prior7d ? candidate.stargazersCount - prior7d.stargazersCount : null,
      forkDelta24h: prior24h ? candidate.forksCount - prior24h.forksCount : null,
      forkDelta7d: prior7d ? candidate.forksCount - prior7d.forksCount : null,
    };
  });
}

/**
 * Delete dated daily snapshot files older than the retention window. Only
 * files matching the module's exact `YYYY-MM-DD.json` pattern are ever
 * touched; latest.json and arbitrary sibling files are preserved. Remaining
 * dated files are capped at `retentionDays` as a defensive bound.
 */
export function pruneDiscoverySnapshots(dir: string, retentionDays: number, now: Date): PruneDiscoverySnapshotsOutput {
  const today = dateKey(now);
  const earliest = addDays(today, -retentionDays);
  const dated = listDatedSnapshotFiles(dir);

  const removed: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];
  for (const file of dated) {
    const date = file.slice(0, 10);
    if (date <= earliest) removed.push(file);
    else kept.push(file);
  }
  while (kept.length > retentionDays) {
    const oldest = kept.shift();
    if (oldest) removed.push(oldest);
  }
  for (const file of removed) {
    try {
      rmSync(join(dir, file));
    } catch (error) {
      warnings.push(`could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, kept, warnings };
}

function listDatedSnapshotFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => SNAPSHOT_DATE_PATTERN.test(entry)).sort();
}

function isUsableHistoryEntry(entry: DiscoveryCandidate): boolean {
  if (entry === null || typeof entry !== "object") return false;
  return (
    typeof entry.canonicalUrl === "string" &&
    entry.canonicalUrl !== "" &&
    Number.isFinite(entry.stargazersCount) &&
    Number.isFinite(entry.forksCount)
  );
}

function latestOnOrBefore(
  observations: DiscoveryHistoryObservation[],
  limitDate: string
): DiscoveryHistoryObservation | undefined {
  let latest: DiscoveryHistoryObservation | undefined;
  for (const observation of observations) {
    if (observation.date <= limitDate) latest = observation;
    else break;
  }
  return latest;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateKeyValue: string, days: number): string {
  const date = new Date(`${dateKeyValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Deterministic serialization with a stable, explicit field order. */
function serializeSnapshot(snapshot: DiscoverySnapshot): string {
  return JSON.stringify(
    {
      formatVersion: 1,
      runAt: snapshot.runAt,
      retentionDays: snapshot.retentionDays,
      candidates: snapshot.candidates.map(serializeCandidate),
    },
    null,
    2
  );
}

function serializeCandidate(candidate: DiscoveryCandidate): Record<string, unknown> {
  return {
    canonicalUrl: candidate.canonicalUrl,
    fullName: candidate.fullName,
    owner: candidate.owner,
    name: candidate.name,
    createdAt: candidate.createdAt,
    pushedAt: candidate.pushedAt,
    stargazersCount: candidate.stargazersCount,
    forksCount: candidate.forksCount,
    archived: candidate.archived,
    topics: candidate.topics,
    description: candidate.description,
    license: candidate.license,
    defaultBranch: candidate.defaultBranch,
    sourceIds: candidate.sourceIds,
    attentionEvidence: candidate.attentionEvidence.map((evidence) => ({
      sourceId: evidence.sourceId,
      url: evidence.url,
      language: evidence.language ?? null,
      title: evidence.title ?? null,
      excerpt: evidence.excerpt ?? null,
    })),
    relevanceInput: candidate.relevanceInput,
    evidenceQualityInput: candidate.evidenceQualityInput,
    starDelta24h: candidate.starDelta24h,
    starDelta7d: candidate.starDelta7d,
    forkDelta24h: candidate.forkDelta24h,
    forkDelta7d: candidate.forkDelta7d,
    disposition: candidate.disposition,
    alert: candidate.alert,
    promotionEligible: candidate.promotionEligible,
    score: {
      total: candidate.score.total,
      repositorySignal: candidate.score.repositorySignal,
      components: {
        momentum: candidate.score.components.momentum,
        officialIdentity: candidate.score.components.officialIdentity,
        corroboration: candidate.score.components.corroboration,
        relevance: candidate.score.components.relevance,
        evidenceQuality: candidate.score.components.evidenceQuality,
      },
    },
    reasons: candidate.reasons,
  };
}

/**
 * Compact deterministic human review artifact derived from the ranked
 * discovery queue. Contains only date/time, cap/counts, compact candidate
 * public facts, source IDs/URLs, bounded attention evidence,
 * score/disposition/alert/reasons, and warnings. The serializer picks
 * whitelisted fields only and sanitizes every retained text value, so a
 * malformed candidate object can never leak a prompt, LLM output, full
 * remote body, README body, environment value, token, or credential into
 * the artifact.
 */
export interface DiscoveryQueueCounts {
  totalEvaluated: number;
  queued: number;
  suppressed: number;
  alert: number;
  tracked: number;
  new: number;
  watch: number;
}

export interface WriteDiscoveryQueueInput {
  /** Absolute discovery directory; created on demand. */
  dir: string;
  /** Vault-relative path of the dated snapshot this queue was derived from. */
  snapshotPath: string;
  /** ISO run timestamp; its UTC date names the queue file. */
  generatedAt: string;
  /** Cap applied to the candidate list; config validation caps this at 20. */
  maxDailyCandidates: number;
  counts: DiscoveryQueueCounts;
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

export interface WriteDiscoveryQueueOutput {
  queueFile: string;
  queuePath: string;
}

const DISCOVERY_TOKEN_PATTERNS = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function sanitizeDiscoveryText(text: string): string {
  const capped = text.slice(0, DISCOVERY_ATTENTION_EXCERPT_MAX);
  return DISCOVERY_TOKEN_PATTERNS.some((pattern) => pattern.test(capped)) ? "[redacted]" : capped;
}

/**
 * Write the dated `YYYY-MM-DD-queue.json` artifact with a deterministic
 * stable field order. The run timestamp must be a valid ISO instant and the
 * resulting filename is checked before anything is written.
 */
export function writeDiscoveryQueue(input: WriteDiscoveryQueueInput): Result<WriteDiscoveryQueueOutput> {
  const generatedAt = new Date(input.generatedAt);
  if (!Number.isFinite(generatedAt.getTime())) {
    return err("QUEUE_INVALID", "queue generatedAt must be a valid ISO timestamp");
  }
  const queueFile = `${dateKey(generatedAt)}-queue.json`;
  if (!/^\d{4}-\d{2}-\d{2}-queue\.json$/.test(queueFile)) {
    return err("QUEUE_INVALID", `unsafe queue output filename derived from generatedAt: ${queueFile}`);
  }
  const maxDailyCandidates = Number.isFinite(input.maxDailyCandidates)
    ? Math.max(0, Math.floor(input.maxDailyCandidates))
    : 0;
  try {
    mkdirSync(input.dir, { recursive: true });
    const payload = JSON.stringify(
      {
        formatVersion: 1,
        generatedAt: input.generatedAt,
        snapshotPath: input.snapshotPath,
        maxDailyCandidates,
        counts: input.counts,
        candidates: input.candidates.slice(0, maxDailyCandidates).map(serializeQueueCandidate),
        warnings: input.warnings.slice(0, 100).map(sanitizeDiscoveryText),
      },
      null,
      2
    );
    const queuePath = join(input.dir, queueFile);
    writeFileSync(queuePath, payload, "utf8");
    return ok({ queueFile, queuePath });
  } catch (error) {
    return err("QUEUE_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function serializeQueueCandidate(candidate: DiscoveryCandidate): Record<string, unknown> {
  return {
    canonicalUrl: candidate.canonicalUrl,
    fullName: candidate.fullName,
    owner: candidate.owner,
    name: candidate.name,
    description: sanitizeDiscoveryText(candidate.description),
    topics: candidate.topics.slice(0, 20).map(sanitizeDiscoveryText),
    stargazersCount: candidate.stargazersCount,
    forksCount: candidate.forksCount,
    pushedAt: candidate.pushedAt,
    archived: candidate.archived,
    sourceIds: uniqueInOrder(candidate.sourceIds).slice(0, 20),
    attentionEvidence: serializeQueueEvidence(candidate.attentionEvidence),
    score: {
      total: candidate.score.total,
      repositorySignal: candidate.score.repositorySignal,
      components: {
        momentum: candidate.score.components.momentum,
        officialIdentity: candidate.score.components.officialIdentity,
        corroboration: candidate.score.components.corroboration,
        relevance: candidate.score.components.relevance,
        evidenceQuality: candidate.score.components.evidenceQuality,
      },
    },
    disposition: candidate.disposition,
    alert: candidate.alert,
    promotionEligible: candidate.promotionEligible,
    reasons: candidate.reasons.slice(0, 20).map(sanitizeDiscoveryText),
  };
}

function serializeQueueEvidence(evidence: DiscoveryAttentionEvidence[]): Record<string, unknown>[] {
  return evidence.slice(0, DISCOVERY_ATTENTION_EVIDENCE_MAX).map((item) => ({
    sourceId: sanitizeDiscoveryText(item.sourceId),
    url: sanitizeDiscoveryText(item.url),
    language: item.language === undefined ? null : sanitizeDiscoveryText(item.language),
    title: item.title === undefined ? null : sanitizeDiscoveryText(item.title),
    excerpt: item.excerpt === undefined ? null : sanitizeDiscoveryText(item.excerpt),
    englishSummary: item.englishSummary === undefined ? null : sanitizeDiscoveryText(item.englishSummary),
  }));
}

function uniqueInOrder<T>(items: T[]): T[] {
  return [...new Set(items)];
}
