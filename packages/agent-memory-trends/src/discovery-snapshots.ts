import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryCandidate, DiscoverySnapshot } from "./discovery-contracts.js";
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
    } catch {
      // Best-effort prune; an unremovable file is reported as not removed.
    }
  }
  return { removed, kept };
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
