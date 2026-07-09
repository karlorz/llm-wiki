import { readFile } from "node:fs/promises";
import { hostname as nodeHostname, userInfo } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  ok,
  err,
  ExitCode,
  FleetManifestSchema,
  type FleetManifest,
  type Result,
} from "@skillwiki/shared";
import { parseDotenvFile } from "../utils/dotenv.js";

export interface FleetValidateInput {
  file: string;
}

export interface FleetValidateOutput {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
  warnings: string[];
  host_count: number;
  snapshotter?: string;
  humanHint: string;
}

export interface FleetContextInput {
  vault?: string;
  file?: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  osHostname?: string;
  user?: string;
}

export interface FleetContextOutput {
  manifest_loaded: boolean;
  host_id?: string;
  source?: string;
  generated_at: string;
  identity_status: "known" | "unknown" | "invalid";
  resolver_trace: FleetResolverTrace[];
  warnings: string[];
  markdown: string;
  humanHint: string;
}

export interface FleetResolverTrace {
  source: string;
  status: "unset" | "matched" | "unmatched" | "skipped";
  value?: string;
}

type LoadedFleet =
  | { ok: true; manifest: FleetManifest }
  | { ok: false; error: "FILE_NOT_FOUND" | "INVALID_YAML" | "INVALID_FLEET_MANIFEST"; detail?: unknown };

interface OutboundAccess {
  hostId: string;
  sshAliases: string[];
  users: string[];
}

export const FLEET_REL_PATH = join("projects", "llm-wiki", "architecture", "fleet.yaml");

export async function runFleetValidate(input: FleetValidateInput): Promise<{ exitCode: number; result: Result<FleetValidateOutput> }> {
  const loaded = await loadFleetManifest(input.file);
  if (!loaded.ok) {
    if (loaded.error === "FILE_NOT_FOUND") {
      return { exitCode: ExitCode.FILE_NOT_FOUND, result: err("FILE_NOT_FOUND", { path: input.file }) };
    }
    const errors = fleetLoadErrors(loaded);
    return invalidFleet(errors);
  }

  const warnings = fleetWarnings(loaded.manifest);
  const snapshotter = findSnapshotter(loaded.manifest);
  return {
    exitCode: ExitCode.OK,
    result: ok({
      valid: true,
      errors: [],
      warnings,
      host_count: Object.keys(loaded.manifest.hosts).length,
      snapshotter,
      humanHint: `VALID fleet manifest (${Object.keys(loaded.manifest.hosts).length} hosts; snapshotter: ${snapshotter ?? "none"})`
    })
  };
}

export async function runFleetContext(input: FleetContextInput): Promise<{ exitCode: number; result: Result<FleetContextOutput> }> {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? "";
  const cwd = input.cwd ?? process.cwd();
  const osHostname = input.osHostname ?? safeEnvValue(env.HOSTNAME) ?? nodeHostname();
  const user = input.user ?? safeEnvValue(env.USER) ?? safeUserName();
  const vault = input.vault ?? safeEnvValue(env.WIKI_PATH);
  const file = input.file ?? (vault ? join(vault, FLEET_REL_PATH) : undefined);
  const generatedAt = new Date().toISOString();

  const loaded = file ? await loadFleetManifest(file) : { ok: false as const, error: "FILE_NOT_FOUND" as const };
  if (!loaded.ok) {
    const warnings = ["fleet manifest unavailable or invalid"];
    const markdown = formatUnknownContext({
      generatedAt,
      osHostname,
      user,
      cwd,
      vault,
      reason: warnings[0]!,
      trace: [],
      warnings,
    });
    return {
      exitCode: ExitCode.OK,
      result: ok({
        manifest_loaded: false,
        generated_at: generatedAt,
        identity_status: "unknown",
        resolver_trace: [],
        warnings,
        markdown,
        humanHint: markdown,
      })
    };
  }

  const resolved = await resolveFleetHostId({
    manifest: loaded.manifest,
    hostId: input.hostId,
    env,
    home,
    osHostname,
  });

  if (resolved.hostId && !loaded.manifest.hosts[resolved.hostId]) {
    const source = resolved.source ?? "unknown";
    const warnings = [`resolved host id \`${resolved.hostId}\` from ${source} is not in fleet.yaml`];
    const markdown = formatInvalidContext({
      generatedAt,
      hostId: resolved.hostId,
      source,
      osHostname,
      user,
      cwd,
      vault,
      trace: resolved.trace,
      warnings,
    });
    return {
      exitCode: ExitCode.OK,
      result: ok({
        manifest_loaded: true,
        host_id: resolved.hostId,
        source: resolved.source,
        generated_at: generatedAt,
        identity_status: "invalid",
        resolver_trace: resolved.trace,
        warnings,
        markdown,
        humanHint: markdown,
      })
    };
  }

  if (!resolved.hostId) {
    const warnings = ["host identity is unresolved"];
    const markdown = formatUnknownContext({
      generatedAt,
      osHostname,
      user,
      cwd,
      vault,
      reason: warnings[0]!,
      trace: resolved.trace,
      warnings,
    });
    return {
      exitCode: ExitCode.OK,
      result: ok({
        manifest_loaded: true,
        generated_at: generatedAt,
        identity_status: "unknown",
        resolver_trace: resolved.trace,
        warnings,
        markdown,
        humanHint: markdown,
      })
    };
  }

  const markdown = formatKnownContext({
    manifest: loaded.manifest,
    hostId: resolved.hostId,
    source: resolved.source,
    generatedAt,
    osHostname,
    user,
    cwd,
    vault,
    trace: resolved.trace,
  });

  return {
    exitCode: ExitCode.OK,
    result: ok({
      manifest_loaded: true,
      host_id: resolved.hostId,
      source: resolved.source,
      generated_at: generatedAt,
      identity_status: "known",
      resolver_trace: resolved.trace,
      warnings: [],
      markdown,
      humanHint: markdown
    })
  };
}

export interface FleetSatelliteGate {
  satelliteExpected: boolean;
}

export interface FleetManifestAndHost {
  manifest: FleetManifest;
  hostId: string | undefined;
  source: string | undefined;
  warnings: string[];
  identityStatus: FleetContextOutput["identity_status"];
}

function fleetContextEnv(input: FleetContextInput): {
  env: Record<string, string | undefined>;
  home: string;
  osHostname: string;
  vault: string | undefined;
  file: string | undefined;
} {
  const env = input.env ?? process.env;
  const home = input.home ?? env.HOME ?? "";
  const osHostname = input.osHostname ?? safeEnvValue(env.HOSTNAME) ?? nodeHostname();
  const vault = input.vault ?? safeEnvValue(env.WIKI_PATH);
  const file = input.file ?? (vault ? join(vault, FLEET_REL_PATH) : undefined);
  return { env, home, osHostname, vault, file };
}

/** Single load + host resolve for doctor and satellite gate (avoids duplicate YAML parse). */
export async function loadFleetManifestAndHost(
  input: FleetContextInput
): Promise<FleetManifestAndHost | null> {
  const { env, home, osHostname, file } = fleetContextEnv(input);
  if (!file) return null;

  const loaded = await loadFleetManifest(file);
  if (!loaded.ok) return null;

  const resolved = await resolveFleetHostId({
    manifest: loaded.manifest,
    hostId: input.hostId,
    env,
    home,
    osHostname,
  });

  if (!resolved.hostId) {
    return {
      manifest: loaded.manifest,
      hostId: undefined,
      source: resolved.source,
      warnings: ["host identity is unresolved"],
      identityStatus: "unknown",
    };
  }

  if (!loaded.manifest.hosts[resolved.hostId]) {
    const source = resolved.source ?? "unknown";
    return {
      manifest: loaded.manifest,
      hostId: resolved.hostId,
      source: resolved.source,
      warnings: [`resolved host id \`${resolved.hostId}\` from ${source} is not in fleet.yaml`],
      identityStatus: "invalid",
    };
  }

  return {
    manifest: loaded.manifest,
    hostId: resolved.hostId,
    source: resolved.source,
    warnings: [],
    identityStatus: "known",
  };
}

/** First SSH alias from this host to the fleet snapshotter, when fleet access is configured. */
export function snapshotterAliasForLocalHost(
  fleetLoad: FleetManifestAndHost | null,
): string | undefined {
  if (!fleetLoad?.manifest || !fleetLoad.hostId) return undefined;
  const snapshotterId = Object.entries(fleetLoad.manifest.hosts).find(([, h]) => h.role === "snapshotter")?.[0];
  if (!snapshotterId) return undefined;
  const profile = fleetLoad.manifest.hosts[snapshotterId]?.access?.from?.[fleetLoad.hostId];
  if (!profile || (profile.status !== "configured" && profile.status !== "local")) return undefined;
  const aliases = profile.ssh_aliases ?? [];
  return aliases.length > 0 ? aliases[0] : undefined;
}

export function satelliteGateFromFleetLoad(load: FleetManifestAndHost | null): FleetSatelliteGate {
  if (!load?.hostId) return { satelliteExpected: false };
  const host = load.manifest.hosts[load.hostId];
  if (!host) return { satelliteExpected: false };
  return { satelliteExpected: host.maintenance?.skillwiki_satellite?.enabled === true };
}

/** True when the resolved fleet host has maintenance.skillwiki_satellite.enabled. */
export async function resolveFleetSatelliteGate(input: FleetContextInput): Promise<FleetSatelliteGate> {
  const load = await loadFleetManifestAndHost(input);
  return satelliteGateFromFleetLoad(load);
}

export async function loadFleetManifest(file: string): Promise<LoadedFleet> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { ok: false, error: "FILE_NOT_FOUND" };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    return { ok: false, error: "INVALID_YAML", detail: error instanceof Error ? error.message : String(error) };
  }

  const result = FleetManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "INVALID_FLEET_MANIFEST", detail: result.error.issues };
  }

  return { ok: true, manifest: result.data };
}

function invalidFleet(errors: Array<{ path: string; message: string }>): { exitCode: number; result: Result<FleetValidateOutput> } {
  return {
    exitCode: ExitCode.FLEET_MANIFEST_INVALID,
    result: ok({
      valid: false,
      errors,
      warnings: [],
      host_count: 0,
      humanHint: `INVALID fleet manifest\n${errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n")}`
    })
  };
}

function fleetLoadErrors(loaded: Exclude<LoadedFleet, { ok: true }>): Array<{ path: string; message: string }> {
  if (loaded.error === "INVALID_YAML") {
    return [{ path: "", message: `invalid YAML: ${String(loaded.detail ?? "parse failed")}` }];
  }
  if (loaded.error === "INVALID_FLEET_MANIFEST" && Array.isArray(loaded.detail)) {
    return loaded.detail.map((issue) => {
      const zodIssue = issue as { path?: Array<string | number>; message?: string };
      return {
        path: (zodIssue.path ?? []).join("."),
        message: zodIssue.message ?? "invalid value"
      };
    });
  }
  return [{ path: "", message: loaded.error }];
}

function fleetWarnings(manifest: FleetManifest): string[] {
  const warnings: string[] = [];
  for (const [id, host] of Object.entries(manifest.hosts)) {
    if (host.role === "snapshotter" && host.protected !== true) {
      warnings.push(`snapshotter host '${id}' is not protected=true`);
    }
  }
  return warnings;
}

function findSnapshotter(manifest: FleetManifest): string | undefined {
  return Object.entries(manifest.hosts).find(([, host]) => host.role === "snapshotter")?.[0];
}

export async function resolveFleetHostId(input: {
  manifest: FleetManifest;
  hostId?: string;
  env: Record<string, string | undefined>;
  home: string;
  osHostname: string;
}): Promise<{ hostId?: string; source?: string; trace: FleetResolverTrace[] }> {
  const trace: FleetResolverTrace[] = [];
  if (input.hostId) {
    trace.push({ source: "--host-id", status: "matched", value: input.hostId });
    return { hostId: input.hostId, source: "host-id", trace };
  }
  trace.push({ source: "--host-id", status: "unset" });

  if (input.env.SKILLWIKI_HOST_ID) {
    trace.push({ source: "SKILLWIKI_HOST_ID", status: "matched", value: input.env.SKILLWIKI_HOST_ID });
    return { hostId: input.env.SKILLWIKI_HOST_ID, source: "SKILLWIKI_HOST_ID", trace };
  }
  trace.push({ source: "SKILLWIKI_HOST_ID", status: "unset" });

  if (input.env.AGENT_HOST_ID) {
    trace.push({ source: "AGENT_HOST_ID", status: "matched", value: input.env.AGENT_HOST_ID });
    return { hostId: input.env.AGENT_HOST_ID, source: "AGENT_HOST_ID", trace };
  }
  trace.push({ source: "AGENT_HOST_ID", status: "unset" });

  if (input.home) {
    const dotenv = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
    if (dotenv.SKILLWIKI_HOST_ID) {
      trace.push({ source: "~/.skillwiki/.env:SKILLWIKI_HOST_ID", status: "matched", value: dotenv.SKILLWIKI_HOST_ID });
      return { hostId: dotenv.SKILLWIKI_HOST_ID, source: "~/.skillwiki/.env:SKILLWIKI_HOST_ID", trace };
    }
    trace.push({ source: "~/.skillwiki/.env:SKILLWIKI_HOST_ID", status: "unset" });
  } else {
    trace.push({ source: "~/.skillwiki/.env:SKILLWIKI_HOST_ID", status: "skipped" });
  }

  if (input.env.VS_HOSTNAME) {
    trace.push({ source: "VS_HOSTNAME", status: "matched", value: input.env.VS_HOSTNAME });
    return { hostId: input.env.VS_HOSTNAME, source: "VS_HOSTNAME", trace };
  }
  trace.push({ source: "VS_HOSTNAME", status: "unset" });

  const hostname = input.osHostname.trim();
  if (hostname) {
    if (input.manifest.hosts[hostname]) {
      trace.push({ source: "hostname", status: "matched", value: hostname });
      return { hostId: hostname, source: "hostname", trace };
    }
    const byHostname = Object.entries(input.manifest.hosts).find(([, host]) => host.identity.hostnames.includes(hostname));
    if (byHostname) {
      trace.push({ source: "hostname", status: "matched", value: hostname });
      return { hostId: byHostname[0], source: "hostname", trace };
    }
    trace.push({ source: "hostname", status: "unmatched", value: hostname });
  } else {
    trace.push({ source: "hostname", status: "unset" });
  }

  return { trace };
}

function formatKnownContext(input: {
  manifest: FleetManifest;
  hostId: string;
  source?: string;
  generatedAt: string;
  osHostname: string;
  user: string;
  cwd: string;
  vault?: string;
  trace: FleetResolverTrace[];
}): string {
  const host = input.manifest.hosts[input.hostId]!;
  const protectedValue = host.protected === true ? "true" : "false";
  const writesTo = host.writes_to.join(", ");
  const selfAliases = collectSelfAliases(input.manifest, input.hostId);
  const outbound = collectOutboundAccess(input.manifest, input.hostId);
  const maintenanceLines = formatMaintenanceLines(host);

  const guidance = host.role === "snapshotter" && host.protected === true
    ? `this session is already on \`${input.hostId}\`; this is a protected snapshotter host. Live-vault authoring at the resolved \`skillwiki path\` is allowed here. Do not mutate snapshot worktrees or repo-local project workspaces from this session except explicitly approved snapshot maintenance. Keep release-validation workflows read-only when they are documented as such.`
    : input.hostId === "macos-dev"
      ? "use declared SSH aliases for remote work when needed; do not assume undeclared hosts have reciprocal SSH access."
      : `this session is already on \`${input.hostId}\`; do not SSH to self aliases unless the user explicitly asks. Do not assume outbound SSH to other fleet hosts is configured.`;

  return [
    "## Runtime Host Context",
    "",
    `- Context generated: \`${input.generatedAt}\``,
    `- Current machine: \`${input.hostId}\`${input.source ? ` (source: \`${input.source}\`)` : ""}`,
    "- Identity status: `known`",
    `- Identity resolution: ${formatResolution(input.source, input.hostId)}`,
    `- Resolver trace: ${formatTrace(input.trace)}`,
    `- OS hostname: ${formatMaybe(input.osHostname)}`,
    `- User: ${formatMaybe(input.user)}`,
    `- Workspace: ${formatMaybe(input.cwd)}`,
    `- Vault: ${formatMaybe(input.vault)}`,
    "- Remote freshness: not checked by `fleet context`; run `sync status` or presync before host-sensitive work.",
    `- Fleet role: \`${host.role}\`; protected: \`${protectedValue}\`; writes_to: \`${writesTo}\``,
    ...maintenanceLines,
    `- Self SSH aliases known in fleet: ${formatList(selfAliases)}`,
    `- Declared outbound SSH from this source: ${formatOutboundAccess(outbound)}`,
    `- Guidance: ${guidance}`,
  ].join("\n");
}

function formatUnknownContext(input: {
  generatedAt: string;
  osHostname: string;
  user: string;
  cwd: string;
  vault?: string;
  reason: string;
  trace: FleetResolverTrace[];
  warnings: string[];
}): string {
  return [
    "## Runtime Host Context",
    "",
    `- Context generated: \`${input.generatedAt}\``,
    "- Current machine: unknown",
    "- Identity status: `unknown`",
    `- Resolver trace: ${formatTrace(input.trace)}`,
    `- Warnings: ${formatWarnings(input.warnings)}`,
    `- OS hostname: ${formatMaybe(input.osHostname)}`,
    `- User: ${formatMaybe(input.user)}`,
    `- Workspace: ${formatMaybe(input.cwd)}`,
    `- Vault: ${formatMaybe(input.vault)}`,
    "- Remote freshness: not checked by `fleet context`; run `sync status` or presync before host-sensitive work.",
    "- Fleet role: unknown",
    "- Self SSH aliases known in fleet: unknown",
    "- Declared outbound SSH from this source: unknown",
    `- Guidance: ${input.reason}; do not assume local vs remote role. Inspect runtime or ask before SSH/deploy/sync work.`,
  ].join("\n");
}

function formatInvalidContext(input: {
  generatedAt: string;
  hostId: string;
  source: string;
  osHostname: string;
  user: string;
  cwd: string;
  vault?: string;
  trace: FleetResolverTrace[];
  warnings: string[];
}): string {
  return [
    "## Runtime Host Context",
    "",
    `- Context generated: \`${input.generatedAt}\``,
    "- Current machine: unknown",
    "- Identity status: `invalid`",
    `- Identity resolution: ${formatResolution(input.source, input.hostId)}`,
    `- Resolver trace: ${formatTrace(input.trace)}`,
    `- Warnings: ${formatWarnings(input.warnings)}`,
    `- OS hostname: ${formatMaybe(input.osHostname)}`,
    `- User: ${formatMaybe(input.user)}`,
    `- Workspace: ${formatMaybe(input.cwd)}`,
    `- Vault: ${formatMaybe(input.vault)}`,
    "- Remote freshness: not checked by `fleet context`; run `sync status` or presync before host-sensitive work.",
    "- Fleet role: unknown",
    "- Self SSH aliases known in fleet: unknown",
    "- Declared outbound SSH from this source: unknown",
    `- Guidance: do not trust this identity; rerun with \`--host-id\` only if the user confirms \`${input.hostId}\` is the current fleet host id.`,
  ].join("\n");
}

function collectSelfAliases(manifest: FleetManifest, hostId: string): string[] {
  const aliases: string[] = [];
  const host = manifest.hosts[hostId];
  const access = host?.access?.from ?? {};
  for (const profile of Object.values(access)) {
    for (const alias of profile.ssh_aliases ?? []) aliases.push(alias);
  }

  return [...new Set(aliases)];
}

function collectOutboundAccess(manifest: FleetManifest, sourceHostId: string): OutboundAccess[] {
  const hosts: OutboundAccess[] = [];
  for (const [targetId, target] of Object.entries(manifest.hosts)) {
    if (targetId === sourceHostId) continue;
    const profile = target.access?.from?.[sourceHostId];
    if (profile && (profile.status === "configured" || profile.status === "local")) {
      hosts.push({
        hostId: targetId,
        sshAliases: [...new Set(profile.ssh_aliases ?? [])],
        users: [...new Set(profile.users ?? [])],
      });
    }
  }
  return hosts.sort((left, right) => left.hostId.localeCompare(right.hostId));
}

function formatMaintenanceLines(host: FleetManifest["hosts"][string]): string[] {
  const satellite = host.maintenance?.skillwiki_satellite;
  if (!satellite?.enabled) return [];

  return [
    `- Maintenance role: \`skillwiki satellite\`; user: \`${satellite.user}\`; ssh: \`${satellite.ssh_alias}\``,
    `- Maintenance paths: maintenance vault: \`${satellite.vault_path}\`; repo: \`${satellite.repo_path}\`; scheduler: \`${satellite.scheduler}\`; jobs: ${formatList(satellite.jobs)}`,
  ];
}

function formatOutboundAccess(values: OutboundAccess[]): string {
  if (values.length === 0) return "none";
  return values.map((value) => {
    const aliasPart = value.sshAliases.length > 0 ? ` via ${formatList(value.sshAliases)}` : " (no SSH aliases)";
    const usersPart = value.users.length > 0 ? ` (users: ${formatList(value.users)})` : "";
    return `\`${value.hostId}\`${aliasPart}${usersPart}`;
  }).join("; ");
}

function formatResolution(source: string | undefined, hostId: string): string {
  return source ? `\`${source === "host-id" ? "--host-id" : source}\` -> \`${hostId}\`` : `unknown -> \`${hostId}\``;
}

function formatTrace(values: FleetResolverTrace[]): string {
  if (values.length === 0) return "not available";
  return values.map((value) => {
    const source = `\`${value.source}\``;
    if (value.status === "matched") return `${source} matched \`${value.value ?? ""}\``;
    if (value.status === "unmatched") return `${source} unmatched \`${value.value ?? ""}\``;
    return `${source} ${value.status}`;
  }).join("; ");
}

function formatWarnings(values: string[]): string {
  return values.length > 0 ? values.join("; ") : "none";
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.map((v) => `\`${v}\``).join(", ") : "none";
}

function formatMaybe(value: string | undefined): string {
  return value && value.trim().length > 0 ? `\`${value}\`` : "unknown";
}

function safeEnvValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function safeUserName(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}
