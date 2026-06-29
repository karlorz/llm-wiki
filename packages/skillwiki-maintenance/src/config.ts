import yaml from "js-yaml";
import { FleetManifestSchema } from "@skillwiki/shared";
import { err, ok, type MaintenanceJobId, type Result } from "./types.js";

export const APPROVED_JOB_ORDER = [
  "self-update-check",
  "vault-sync-preflight",
  "agent-memory-trends-daily",
  "session-brief-refresh",
  "health-summary",
] as const satisfies readonly MaintenanceJobId[];

export interface MaintenanceConfig {
  sourcePath: string;
  hostId: string;
  protectedHost: boolean;
  enabled: boolean;
  user: string;
  vaultPath: string;
  repoPath: string;
  sshAlias: string;
  scheduler: "systemd";
  timezone: string;
  jobs: MaintenanceJobId[];
  cadence: {
    selfUpdateCheck: { everyHours: 4 };
    dailyWindow: { time: string; timezone: string };
  };
}

export function parseMaintenanceConfig(text: string, hostId: string, sourcePath: string): Result<MaintenanceConfig> {
  let parsed: unknown;
  try {
    parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return err("CONFIG_INVALID", `invalid YAML in ${sourcePath}: ${messageOf(error)}`);
  }

  const manifest = FleetManifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return err("CONFIG_INVALID", manifest.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }

  const host = manifest.data.hosts[hostId];
  if (!host) return err("CONFIG_INVALID", `host not found in fleet manifest: ${hostId}`);

  const satellite = host.maintenance?.skillwiki_satellite;
  if (!satellite) return err("CONFIG_INVALID", `host ${hostId} has no maintenance.skillwiki_satellite config`);
  if (!satellite.enabled) return err("CONFIG_INVALID", `host ${hostId} skillwiki satellite is disabled`);

  const jobs = satellite.jobs as MaintenanceJobId[];
  const approvedJobs = ensureApprovedJobOrder(jobs);
  if (!approvedJobs.ok) return approvedJobs;

  const cadence = parseCadence(satellite.cadence, satellite.timezone ?? "Asia/Hong_Kong");
  if (!cadence.ok) return cadence;

  return ok({
    sourcePath,
    hostId,
    protectedHost: host.protected ?? false,
    enabled: satellite.enabled,
    user: satellite.user,
    vaultPath: satellite.vault_path,
    repoPath: satellite.repo_path,
    sshAlias: satellite.ssh_alias,
    scheduler: satellite.scheduler,
    timezone: satellite.timezone ?? "Asia/Hong_Kong",
    jobs: approvedJobs.data,
    cadence: cadence.data,
  });
}

export function ensureApprovedJobOrder(jobs: MaintenanceJobId[]): Result<MaintenanceJobId[]> {
  if (jobs.join("\n") !== APPROVED_JOB_ORDER.join("\n")) {
    return err("CONFIG_INVALID", `jobs must match approved Stage 1 job order: ${APPROVED_JOB_ORDER.join(", ")}`);
  }
  return ok(jobs);
}

function parseCadence(
  cadence: { self_update_check?: "every-4-hours"; daily_window?: string } | undefined,
  defaultTimezone: string
): Result<MaintenanceConfig["cadence"]> {
  if (cadence?.self_update_check !== "every-4-hours") {
    return err("CONFIG_INVALID", "cadence.self_update_check must be every-4-hours");
  }

  const daily = cadence.daily_window ?? `00:10 ${defaultTimezone}`;
  const match = daily.match(/^(\d{2}:\d{2})\s+(.+)$/);
  if (!match) return err("CONFIG_INVALID", "cadence.daily_window must look like HH:MM Time/Zone");

  return ok({
    selfUpdateCheck: { everyHours: 4 },
    dailyWindow: {
      time: match[1]!,
      timezone: match[2]!,
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
