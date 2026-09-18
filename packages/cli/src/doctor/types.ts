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
  /** When true, live-handshake HTTP MCP (Task 2). Default false — skip, no network. */
  checkMcp?: boolean;
  /** Injectable fetch for MCP handshake tests. Default path must not call it. */
  mcpFetch?: typeof fetch;
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
  /** Absent or true: push-enabled leaf. false: fetch-only leaf. */
  pushEnabled?: boolean;
}

export interface DoctorContext {
  input: DoctorInput;
  devSourceRun: boolean;
  vsConfig: VaultSyncRuntimeConfig;
  resolvedPath: string | undefined;
  wikiPathSource?: string;
  gitCheckPath: string | undefined;
  fleetLoad: FleetManifestAndHost | null;
  readOnlyScanRoot: string | undefined;
  satelliteGate: FleetSatelliteGate;
  /** No local vault, vault-sync not installed, MCP token present. */
  mcpOnlyLeaf: boolean;
}

export interface DoctorProbe {
  id: string;
  label?: string;
  run(ctx: DoctorContext): Promise<CheckResult[]> | CheckResult[];
}
