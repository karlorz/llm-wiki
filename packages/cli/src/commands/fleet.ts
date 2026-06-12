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
  markdown: string;
  humanHint: string;
}

type LoadedFleet =
  | { ok: true; manifest: FleetManifest }
  | { ok: false; error: "FILE_NOT_FOUND" | "INVALID_YAML" | "INVALID_FLEET_MANIFEST"; detail?: unknown };

interface OutboundAccess {
  hostId: string;
  sshAliases: string[];
  users: string[];
}

const FLEET_REL_PATH = join("projects", "llm-wiki", "architecture", "fleet.yaml");

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

  const loaded = file ? await loadFleetManifest(file) : { ok: false as const, error: "FILE_NOT_FOUND" as const };
  if (!loaded.ok) {
    const markdown = formatUnknownContext({ osHostname, user, cwd, vault, reason: "fleet manifest unavailable or invalid" });
    return {
      exitCode: ExitCode.OK,
      result: ok({ manifest_loaded: false, markdown, humanHint: markdown })
    };
  }

  const resolved = await resolveHostId({
    manifest: loaded.manifest,
    hostId: input.hostId,
    env,
    home,
    osHostname,
  });

  if (!resolved.hostId || !loaded.manifest.hosts[resolved.hostId]) {
    const markdown = formatUnknownContext({ osHostname, user, cwd, vault, reason: "host identity is unresolved" });
    return {
      exitCode: ExitCode.OK,
      result: ok({ manifest_loaded: true, markdown, humanHint: markdown })
    };
  }

  const markdown = formatKnownContext({
    manifest: loaded.manifest,
    hostId: resolved.hostId,
    source: resolved.source,
    osHostname,
    user,
    cwd,
    vault,
  });

  return {
    exitCode: ExitCode.OK,
    result: ok({
      manifest_loaded: true,
      host_id: resolved.hostId,
      source: resolved.source,
      markdown,
      humanHint: markdown
    })
  };
}

async function loadFleetManifest(file: string): Promise<LoadedFleet> {
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

async function resolveHostId(input: {
  manifest: FleetManifest;
  hostId?: string;
  env: Record<string, string | undefined>;
  home: string;
  osHostname: string;
}): Promise<{ hostId?: string; source?: string }> {
  if (input.hostId) return { hostId: input.hostId, source: "host-id" };
  if (input.env.SKILLWIKI_HOST_ID) return { hostId: input.env.SKILLWIKI_HOST_ID, source: "SKILLWIKI_HOST_ID" };
  if (input.env.AGENT_HOST_ID) return { hostId: input.env.AGENT_HOST_ID, source: "AGENT_HOST_ID" };

  if (input.home) {
    const dotenv = await parseDotenvFile(join(input.home, ".skillwiki", ".env"));
    if (dotenv.SKILLWIKI_HOST_ID) {
      return { hostId: dotenv.SKILLWIKI_HOST_ID, source: "~/.skillwiki/.env:SKILLWIKI_HOST_ID" };
    }
  }

  if (input.env.VS_HOSTNAME) return { hostId: input.env.VS_HOSTNAME, source: "VS_HOSTNAME" };

  const hostname = input.osHostname.trim();
  if (hostname) {
    if (input.manifest.hosts[hostname]) return { hostId: hostname, source: "hostname" };
    const byHostname = Object.entries(input.manifest.hosts).find(([, host]) => host.identity.hostnames.includes(hostname));
    if (byHostname) return { hostId: byHostname[0], source: "hostname" };
  }

  return {};
}

function formatKnownContext(input: {
  manifest: FleetManifest;
  hostId: string;
  source?: string;
  osHostname: string;
  user: string;
  cwd: string;
  vault?: string;
}): string {
  const host = input.manifest.hosts[input.hostId]!;
  const protectedValue = host.protected === true ? "true" : "false";
  const writesTo = host.writes_to.join(", ");
  const selfAliases = collectSelfAliases(input.manifest, input.hostId);
  const outbound = collectOutboundAccess(input.manifest, input.hostId);
  const maintenanceLines = formatMaintenanceLines(host);

  const guidance = input.hostId === "macos-dev"
    ? "use declared SSH aliases for remote work when needed; do not assume undeclared hosts have reciprocal SSH access."
    : `this session is already on \`${input.hostId}\`; do not SSH to self aliases unless the user explicitly asks. Do not assume outbound SSH to other fleet hosts is configured.`;

  return [
    "## Runtime Host Context",
    "",
    `- Current machine: \`${input.hostId}\`${input.source ? ` (source: \`${input.source}\`)` : ""}`,
    `- OS hostname: ${formatMaybe(input.osHostname)}`,
    `- User: ${formatMaybe(input.user)}`,
    `- Workspace: ${formatMaybe(input.cwd)}`,
    `- Vault: ${formatMaybe(input.vault)}`,
    `- Fleet role: \`${host.role}\`; protected: \`${protectedValue}\`; writes_to: \`${writesTo}\``,
    ...maintenanceLines,
    `- Self SSH aliases known in fleet: ${formatList(selfAliases)}`,
    `- Declared outbound SSH from this source: ${formatOutboundAccess(outbound)}`,
    `- Guidance: ${guidance}`,
  ].join("\n");
}

function formatUnknownContext(input: {
  osHostname: string;
  user: string;
  cwd: string;
  vault?: string;
  reason: string;
}): string {
  return [
    "## Runtime Host Context",
    "",
    "- Current machine: unknown",
    `- OS hostname: ${formatMaybe(input.osHostname)}`,
    `- User: ${formatMaybe(input.user)}`,
    `- Workspace: ${formatMaybe(input.cwd)}`,
    `- Vault: ${formatMaybe(input.vault)}`,
    "- Fleet role: unknown",
    "- Self SSH aliases known in fleet: unknown",
    "- Declared outbound SSH from this source: unknown",
    `- Guidance: ${input.reason}; do not assume local vs remote role. Inspect runtime or ask before SSH/deploy/sync work.`,
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
