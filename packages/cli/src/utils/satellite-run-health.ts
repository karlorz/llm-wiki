import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SATELLITE_STALE_MS = 26 * 60 * 60 * 1000;

export interface SatelliteLatestRunWire {
  status: string;
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
    return { status, finishedAt, failureClass };
  } catch {
    return null;
  }
}

export function readSatelliteLatestRunFromText(text: string): SatelliteLatestRunWire | null {
  return parseLatestRunFile(text);
}

export function readSatelliteLatestRun(vault: string): SatelliteLatestRunWire | null {
  const latestPath = satelliteLatestRunPath(vault);
  if (!existsSync(latestPath)) return null;
  try {
    return parseLatestRunFile(readFileSync(latestPath, "utf8"));
  } catch {
    return null;
  }
}

export function evaluateSatelliteRunHealth(vault: string, now: Date): SatelliteRunHealthEvaluation {
  const run = readSatelliteLatestRun(vault);
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