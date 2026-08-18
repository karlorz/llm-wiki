import type { Result } from "@skillwiki/shared";
import type { ExecProbe } from "../utils/remote-health.js";
import type { FleetManifestAndHost, FleetSatelliteGate } from "../commands/fleet.js";

export type CheckStatus = "pass" | "info" | "warn" | "error";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorOutput {
  checks: CheckResult[];
  summary: { pass: number; info: number; warn: number; error: number };
  humanHint: string;
}

export interface DoctorInput {
  home: string;
  envValue: string | undefined;
  argv: string[];
  currentVersion: string;
  cwd?: string;
  /** When true, SSH-probe fleet snapshotter (short timeout). Default false. */
  checkSnapshotter?: boolean;
  /** Injectable exec for reachability probes (tests). */
  execProbe?: ExecProbe;
  /** Injectable process env for remote resolution (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface VaultSyncRuntimeConfig {
  installed: boolean;
  role?: string;
  serviceScope?: string;
  snapshotScript?: string;
}

export interface DoctorContext {
  input: DoctorInput;
  devSourceRun: boolean;
  vsConfig: VaultSyncRuntimeConfig;
  resolvedPath: string | undefined;
  gitCheckPath: string | undefined;
  fleetLoad: FleetManifestAndHost | null;
  readOnlyScanRoot: string | undefined;
  satelliteGate: FleetSatelliteGate;
}

export interface DoctorProbe {
  id: string;
  label?: string;
  run(ctx: DoctorContext): Promise<CheckResult[]> | CheckResult[];
}
