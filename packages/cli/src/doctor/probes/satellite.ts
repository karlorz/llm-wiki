import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";
import { evaluateSatelliteRunHealth, satelliteLatestRunPath } from "../../utils/satellite-run-health.js";
import type { CheckResult, DoctorContext, DoctorProbe } from "../types.js";
import { check } from "./helpers.js";

export function checkSatelliteLastRun(vaultPath: string | undefined, satelliteExpected: boolean): CheckResult {
  if (!satelliteExpected) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "Satellite job not expected on this host");
  }
  if (vaultPath === undefined) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "No vault path — check skipped");
  }
  const latestPath = satelliteLatestRunPath(vaultPath);
  if (!existsSync(latestPath)) {
    return check("pass", "satellite_job_last_run", "Satellite job last run", "No latest-run.json — satellite has not run yet");
  }
  try {
    const health = evaluateSatelliteRunHealth(vaultPath, new Date());
    if (health.failed) {
      const fc = health.failureClass;
      const detail = fc ? `Last satellite run failed (failure_class: ${fc})` : "Last satellite run failed";
      return check("error", "satellite_job_last_run", "Satellite job last run", detail);
    }
    if (health.stale && health.finishedAt) {
      return check(
        "warn",
        "satellite_job_last_run",
        "Satellite job last run",
        `Last run finished_at is older than 26h (${health.finishedAt})`
      );
    }
    return check(
      "pass",
      "satellite_job_last_run",
      "Satellite job last run",
      health.finishedAt ? `Last run ok (finished_at ${health.finishedAt})` : "Last run ok"
    );
  } catch {
    return check("warn", "satellite_job_last_run", "Satellite job last run", `Could not read ${latestPath}`);
  }
}

export interface SatelliteTimerDeps {
  platform: () => NodeJS.Platform;
  systemctlIsActive: (unit: string) => string | undefined;
}

function defaultSatelliteTimerDeps(): SatelliteTimerDeps {
  return {
    platform: () => platform(),
    systemctlIsActive: (unit) => {
      try {
        return execSync(`systemctl is-active ${unit}`, {
          encoding: "utf8",
          timeout: 2000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return undefined;
      }
    },
  };
}

export function checkSatelliteTimer(
  satelliteExpected: boolean,
  deps: SatelliteTimerDeps = defaultSatelliteTimerDeps()
): CheckResult {
  if (!satelliteExpected) {
    return check("pass", "satellite_job_timer", "Satellite job timer", "Satellite job not expected on this host");
  }
  if (deps.platform() !== "linux") {
    return check("pass", "satellite_job_timer", "Satellite job timer", "Timer check skipped — Linux only");
  }
  const out = deps.systemctlIsActive("agent-memory-trends.timer");
  if (out === undefined) {
    return check("pass", "satellite_job_timer", "Satellite job timer", "systemctl unavailable");
  }
  if (out === "active") {
    return check("pass", "satellite_job_timer", "Satellite job timer", "systemd: agent-memory-trends.timer active");
  }
  return check(
    "error",
    "satellite_job_timer",
    "Satellite job timer",
    `systemd: agent-memory-trends.timer is ${out || "not active"}`
  );
}

export const satelliteProbe: DoctorProbe = {
  id: "satellite",
  run(ctx: DoctorContext): CheckResult[] {
    return [
      checkSatelliteLastRun(ctx.resolvedPath, ctx.satelliteGate.satelliteExpected),
      checkSatelliteTimer(ctx.satelliteGate.satelliteExpected),
    ];
  },
};
