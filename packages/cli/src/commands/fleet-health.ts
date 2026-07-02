import { existsSync, readFileSync } from "node:fs";
import { execSync as nodeExecSync } from "node:child_process";
import { hostname as nodeHostname, platform as nodePlatform } from "node:os";
import { join } from "node:path";
import { ok, err, ExitCode, type FleetManifest, type Result } from "@skillwiki/shared";
import {
  FLEET_REL_PATH,
  loadFleetManifest,
  resolveFleetHostId,
  type FleetContextInput,
} from "./fleet.js";
import {
  isFailedRunStatus,
  readSatelliteLatestRunFromText,
  SATELLITE_STALE_MS,
  satelliteLatestRunPath,
} from "../utils/satellite-run-health.js";
const SSH_TIMEOUT_MS = 15_000;
const TIMER_UNIT = "agent-memory-trends.timer";

export type FleetHealthTimer = "active" | "inactive" | "unknown";
export type FleetHealthRunStatus = "success" | "fail" | "unknown" | "none";
export type FleetHealthReachable = "yes" | "no";

export interface FleetHealthHostRow {
  host: string;
  timer: FleetHealthTimer;
  last_run_status: FleetHealthRunStatus;
  last_run_age: string;
  failure_class: string;
  reachable: FleetHealthReachable;
  healthy: boolean;
}

export interface FleetHealthInput extends FleetContextInput {
  json?: boolean;
  deps?: FleetHealthDeps;
}

export interface FleetHealthOutput {
  hosts: FleetHealthHostRow[];
  humanHint: string;
}

export interface FleetHealthDeps {
  platform: () => NodeJS.Platform;
  execSync: typeof nodeExecSync;
}

function defaultDeps(): FleetHealthDeps {
  return {
    platform: () => nodePlatform(),
    execSync: nodeExecSync,
  };
}

function formatAgeHours(finishedAt: string | undefined): string {
  if (!finishedAt) return "never";
  const ts = Date.parse(finishedAt);
  if (!Number.isFinite(ts)) return "unknown";
  const hours = Math.floor((Date.now() - ts) / (60 * 60 * 1000));
  if (hours < 1) return "<1h";
  return `${hours}h`;
}

function deriveRunFields(parsed: {
  status?: string;
  finished_at?: string;
  failure_class?: string | null;
} | null): {
  last_run_status: FleetHealthRunStatus;
  last_run_age: string;
  failure_class: string;
  runUnhealthy: boolean;
} {
  if (!parsed) {
    return {
      last_run_status: "unknown",
      last_run_age: "never",
      failure_class: "-",
      runUnhealthy: false,
    };
  }
  const finishedAt = parsed.finished_at;
  const age = formatAgeHours(finishedAt);
  const fc =
    parsed.failure_class != null && String(parsed.failure_class).length > 0
      ? String(parsed.failure_class)
      : "-";

  if (isFailedRunStatus(parsed.status ?? "")) {
    return {
      last_run_status: "fail",
      last_run_age: age,
      failure_class: fc === "-" ? "fail" : fc,
      runUnhealthy: true,
    };
  }

  if (finishedAt) {
    const ts = Date.parse(finishedAt);
    if (Number.isFinite(ts) && Date.now() - ts > SATELLITE_STALE_MS) {
      return {
        last_run_status: "success",
        last_run_age: age,
        failure_class: "-",
        runUnhealthy: true,
      };
    }
  }

  if (parsed.status === "success" || parsed.status === "ok") {
    return {
      last_run_status: "success",
      last_run_age: age,
      failure_class: "-",
      runUnhealthy: false,
    };
  }

  return {
    last_run_status: parsed.status ? "unknown" : "none",
    last_run_age: age,
    failure_class: "-",
    runUnhealthy: false,
  };
}

function systemctlIsActiveLocal(deps: FleetHealthDeps, unit: string): FleetHealthTimer {
  if (deps.platform() !== "linux") return "unknown";
  try {
    const out = deps
      .execSync(`systemctl is-active ${unit}`, {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();
    return out === "active" ? "active" : "inactive";
  } catch {
    return "unknown";
  }
}

function probeLocal(vaultPath: string, deps: FleetHealthDeps): Omit<FleetHealthHostRow, "host" | "reachable" | "healthy"> & {
  reachable: FleetHealthReachable;
  runUnhealthy: boolean;
  timerBad: boolean;
} {
  const latestPath = satelliteLatestRunPath(vaultPath);
  let parsed: {
    status?: string;
    finished_at?: string;
    failure_class?: string | null;
  } | null = null;
  if (existsSync(latestPath)) {
    try {
      const wire = readSatelliteLatestRunFromText(readFileSync(latestPath, "utf8"));
      if (wire) {
        parsed = {
          status: wire.status,
          finished_at: wire.finishedAt,
          failure_class: wire.failureClass ?? null,
        };
      }
    } catch {
      parsed = null;
    }
  }
  const run = deriveRunFields(parsed);
  const timer = systemctlIsActiveLocal(deps, TIMER_UNIT);
  const timerBad = deps.platform() === "linux" && timer === "inactive";
  return {
    timer,
    last_run_status: run.last_run_status,
    last_run_age: run.last_run_age,
    failure_class: run.failure_class,
    reachable: "yes",
    runUnhealthy: run.runUnhealthy,
    timerBad,
  };
}

function probeRemote(
  sshAlias: string,
  vaultPath: string,
  deps: FleetHealthDeps
): Omit<FleetHealthHostRow, "host" | "healthy"> & { runUnhealthy: boolean; timerBad: boolean } {
  const latest = satelliteLatestRunPath(vaultPath);
  const remoteCmd = [
    `cat ${shellQuote(latest)} 2>/dev/null || true`,
    "echo __SW_TIMER__",
    `systemctl is-active ${TIMER_UNIT} 2>/dev/null || echo inactive`,
    "echo __SW_FAILED__",
    "systemctl is-failed agent-memory-trends.service 2>/dev/null || echo unknown",
  ].join("\n");
  const sshCmd = `ssh -o ConnectTimeout=10 ${sshAlias} ${shellQuote(remoteCmd)}`;
  try {
    const out = deps.execSync(sshCmd, {
      encoding: "utf8",
      timeout: SSH_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timerMarker = "__SW_TIMER__";
    const failedMarker = "__SW_FAILED__";
    const timerIdx = out.indexOf(timerMarker);
    const jsonPart = timerIdx >= 0 ? out.slice(0, timerIdx) : out;
    const afterTimer = timerIdx >= 0 ? out.slice(timerIdx + timerMarker.length) : "";
    const failedIdx = afterTimer.indexOf(failedMarker);
    const timerRaw =
      failedIdx >= 0
        ? afterTimer.slice(0, failedIdx)
        : afterTimer;
    const jsonText = jsonPart.trim();
    const parsed = jsonText.startsWith("{")
      ? (() => {
          const wire = readSatelliteLatestRunFromText(jsonText);
          if (!wire) return null;
          return {
            status: wire.status,
            finished_at: wire.finishedAt,
            failure_class: wire.failureClass ?? null,
          };
        })()
      : null;
    const run = deriveRunFields(parsed);
    const timerLine = timerRaw.trim().split("\n")[0]?.trim() ?? "unknown";
    let timer: FleetHealthTimer = "unknown";
    if (timerLine === "active") timer = "active";
    else if (timerLine === "inactive") timer = "inactive";
    const timerBad = timer === "inactive";
    return {
      timer,
      last_run_status: run.last_run_status,
      last_run_age: run.last_run_age,
      failure_class: run.failure_class,
      reachable: "yes",
      runUnhealthy: run.runUnhealthy,
      timerBad,
    };
  } catch {
    return {
      timer: "unknown",
      last_run_status: "unknown",
      last_run_age: "never",
      failure_class: "-",
      reachable: "no",
      runUnhealthy: true,
      timerBad: true,
    };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function satelliteHosts(manifest: FleetManifest): Array<{ id: string; vaultPath: string; sshAlias: string }> {
  const out: Array<{ id: string; vaultPath: string; sshAlias: string }> = [];
  for (const [id, host] of Object.entries(manifest.hosts)) {
    const sat = host.maintenance?.skillwiki_satellite;
    if (sat?.enabled === true) {
      out.push({ id, vaultPath: sat.vault_path, sshAlias: sat.ssh_alias });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function formatTable(rows: FleetHealthHostRow[]): string {
  if (rows.length === 0) return "no satellite hosts configured";
  const header = "host | timer | last_run_status | last_run_age | failure_class | reachable";
  const lines = rows.map(
    (r) =>
      `${r.host} | ${r.timer} | ${r.last_run_status} | ${r.last_run_age} | ${r.failure_class} | ${r.reachable}`
  );
  return [header, ...lines].join("\n");
}

function rowHealthy(
  reachable: FleetHealthReachable,
  timer: FleetHealthTimer,
  runUnhealthy: boolean,
  timerBad: boolean,
  platform: NodeJS.Platform
): boolean {
  if (reachable === "no") return false;
  if (runUnhealthy) return false;
  if (platform === "linux" && timerBad) return false;
  if (platform === "linux" && timer === "inactive") return false;
  return true;
}

export async function runFleetHealth(
  input: FleetHealthInput
): Promise<{ exitCode: number; result: Result<FleetHealthOutput> }> {
  const deps = input.deps ?? defaultDeps();
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? "";
  const osHostname = input.osHostname ?? env.HOSTNAME ?? nodeHostname();
  const vault = input.vault ?? env.WIKI_PATH;
  const file = input.file ?? (vault ? join(vault, FLEET_REL_PATH) : undefined);

  if (!file) {
    return {
      exitCode: ExitCode.NO_VAULT_CONFIGURED,
      result: err("NO_VAULT_CONFIGURED", { message: "vault path or --file required" }),
    };
  }

  const loaded = await loadFleetManifest(file);
  if (!loaded.ok) {
    if (loaded.error === "FILE_NOT_FOUND") {
      return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: file }) };
    }
    return {
      exitCode: ExitCode.FLEET_MANIFEST_INVALID,
      result: err("INVALID_FLEET_MANIFEST", { path: file }),
    };
  }

  const resolved = await resolveFleetHostId({
    manifest: loaded.manifest,
    hostId: input.hostId,
    env,
    home,
    osHostname,
  });
  const localHostId = resolved.hostId;

  const targets = satelliteHosts(loaded.manifest);
  if (targets.length === 0) {
    const humanHint = "no satellite hosts configured";
    return {
      exitCode: ExitCode.OK,
      result: ok({ hosts: [], humanHint }),
    };
  }

  const rows: FleetHealthHostRow[] = [];
  for (const t of targets) {
    const isLocal = localHostId === t.id;
    if (isLocal) {
      const p = probeLocal(t.vaultPath, deps);
      const healthy = rowHealthy(p.reachable, p.timer, p.runUnhealthy, p.timerBad, deps.platform());
      rows.push({
        host: t.id,
        timer: p.timer,
        last_run_status: p.last_run_status,
        last_run_age: p.last_run_age,
        failure_class: p.failure_class,
        reachable: p.reachable,
        healthy,
      });
    } else {
      const p = probeRemote(t.sshAlias, t.vaultPath, deps);
      const healthy = rowHealthy(p.reachable, p.timer, p.runUnhealthy, p.timerBad, "linux");
      rows.push({
        host: t.id,
        timer: p.timer,
        last_run_status: p.last_run_status,
        last_run_age: p.last_run_age,
        failure_class: p.failure_class,
        reachable: p.reachable,
        healthy,
      });
    }
  }

  const allHealthy = rows.every((r) => r.healthy);
  const humanHint = formatTable(rows);
  const exitCode = allHealthy ? ExitCode.OK : ExitCode.FLEET_SATELLITE_HEALTH_FAILED;

  return {
    exitCode,
    result: ok({ hosts: rows, humanHint }),
  };
}