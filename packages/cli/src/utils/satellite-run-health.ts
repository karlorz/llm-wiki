import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SATELLITE_STALE_MS = 26 * 60 * 60 * 1000;

export interface SatelliteLatestRunWire {
  status: string;
  runDate?: string;
  selectedCandidateCount?: number;
  finishedAt?: string;
  failureClass?: string;
}

export interface SatelliteRunHealthEvaluation {
  failed: boolean;
  stale: boolean;
  failureClass?: string;
  finishedAt?: string;
}

export function satelliteLatestRunPath(vault: string): string {
  return join(vault, ".skillwiki", "agent-memory-trends", "latest-run.json");
}

export function isFailedRunStatus(status: string): boolean {
  return status === "fail" || status === "failure";
}

function parseLatestRunFile(text: string): SatelliteLatestRunWire | null {
  try {
    const parsed = JSON.parse(text) as {
      status?: unknown;
      run_date?: unknown;
      selected_candidate_count?: unknown;
      finished_at?: unknown;
      failure_class?: unknown;
    };
    const status = typeof parsed.status === "string" ? parsed.status : "";
    if (!status) return null;
    const finishedAt =
      typeof parsed.finished_at === "string" && parsed.finished_at.length > 0
        ? parsed.finished_at
        : undefined;
    const failureClass =
      parsed.failure_class != null && String(parsed.failure_class).length > 0
        ? String(parsed.failure_class)
        : undefined;
    const runDate = typeof parsed.run_date === "string" && parsed.run_date.length > 0 ? parsed.run_date : undefined;
    const selectedCandidateCount =
      typeof parsed.selected_candidate_count === "number" &&
      Number.isInteger(parsed.selected_candidate_count) &&
      parsed.selected_candidate_count >= 0
        ? parsed.selected_candidate_count
        : undefined;
    return { status, runDate, selectedCandidateCount, finishedAt, failureClass };
  } catch {
    return null;
  }
}

export function readSatelliteLatestRunFromText(text: string): SatelliteLatestRunWire | null {
  return parseLatestRunFile(text);
}

export function readSatelliteLatestRun(vault: string): SatelliteLatestRunWire | null {
  return readSatelliteLatestRunAt(satelliteLatestRunPath(vault));
}

export function readSatelliteLatestRunAt(path: string): SatelliteLatestRunWire | null {
  if (!existsSync(path)) return null;
  try {
    return parseLatestRunFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function evaluateSatelliteRunHealth(vault: string, now: Date): SatelliteRunHealthEvaluation {
  return evaluateSatelliteRunHealthAt(satelliteLatestRunPath(vault), now);
}

export function evaluateSatelliteRunHealthAt(path: string, now: Date): SatelliteRunHealthEvaluation {
  return evaluateSatelliteRunHealthState(readSatelliteLatestRunAt(path), now);
}

export function evaluateSatelliteRunHealthState(
  run: SatelliteLatestRunWire | null,
  now: Date
): SatelliteRunHealthEvaluation {
  if (!run) {
    return { failed: false, stale: false };
  }
  const failed = isFailedRunStatus(run.status);
  let stale = false;
  if (!failed && run.finishedAt) {
    const ts = Date.parse(run.finishedAt);
    if (Number.isFinite(ts) && now.getTime() - ts > SATELLITE_STALE_MS) {
      stale = true;
    }
  }
  return {
    failed,
    stale,
    failureClass: run.failureClass,
    finishedAt: run.finishedAt,
  };
}
