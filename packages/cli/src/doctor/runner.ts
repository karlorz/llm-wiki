import { ok, ExitCode, type Result } from "@skillwiki/shared";
import { resolveRuntimePath } from "../utils/wiki-path.js";
import { resolveConfiguredSnapshotWorktree } from "../utils/snapshot-worktree.js";
import {
  isMcpOnlyLeaf,
  mcpAuthFromEnv,
  mergeMcpAuthIntoEnv,
  redactMcpSecret,
} from "../utils/mcp-auth-env.js";
import { existsSync } from "node:fs";
import { loadFleetManifestAndHost, satelliteGateFromFleetLoad } from "../commands/fleet.js";
import { DOCTOR_PROBES } from "./probes/index.js";
import { readVaultSyncConfig } from "./probes/vault-sync.js";
import { doctorReadOnlyScanRoot } from "./probes/metrics.js";
import type {
  CheckResult,
  CheckStatus,
  DoctorContext,
  DoctorInput,
  DoctorOutput,
  DoctorProbe,
} from "./types.js";

function isDevSourceRun(argv: string[]): boolean {
  return argv.length >= 2 && argv[1].endsWith("cli.js");
}

function resolveSnapshotGitWorktree(home: string): string | undefined {
  const configured = resolveConfiguredSnapshotWorktree(home);
  if (configured) return configured;
  const defaultPath = "/root/wiki-git";
  return existsSync(defaultPath) ? defaultPath : undefined;
}

export class DoctorRunner {
  private probes: readonly DoctorProbe[];

  constructor(probes: readonly DoctorProbe[] = DOCTOR_PROBES) {
    this.probes = probes;
  }

  getRegisteredProbes(): readonly DoctorProbe[] {
    return this.probes;
  }

  async run(
    input: DoctorInput
  ): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
    const devSourceRun = isDevSourceRun(input.argv);
    const vsConfig = readVaultSyncConfig(input.home);
    const baseEnv = input.env ?? process.env;
    const mergedEnv = await mergeMcpAuthIntoEnv(input.home, baseEnv);
    const auth = mcpAuthFromEnv(mergedEnv);
    const inputWithEnv: DoctorInput = { ...input, env: mergedEnv };

    const resolved = await resolveRuntimePath({
      flag: undefined,
      envValue: input.envValue,
      home: input.home,
      cwd: input.cwd,
    });
    const resolvedPath = resolved.ok ? resolved.data.path : undefined;
    const gitCheckPath = vsConfig.role === "snapshotter"
      ? (resolveSnapshotGitWorktree(input.home) ?? resolvedPath)
      : resolvedPath;
    const mcpOnlyLeaf = isMcpOnlyLeaf({
      resolvedPath,
      token: auth.token,
      vaultSyncInstalled: vsConfig.installed,
    });

    const fleetLoad = resolvedPath
      ? await loadFleetManifestAndHost({
          vault: resolvedPath,
          env: { ...mergedEnv, WIKI_PATH: input.envValue ?? resolvedPath },
          home: input.home,
          cwd: input.cwd,
          osHostname: process.env.HOSTNAME,
          user: process.env.USER,
        })
      : null;

    const satelliteGate = satelliteGateFromFleetLoad(fleetLoad);
    const readOnlyScanRoot = resolvedPath ? doctorReadOnlyScanRoot(resolvedPath) : undefined;

    const ctx: DoctorContext = {
      input: inputWithEnv,
      devSourceRun,
      vsConfig,
      resolvedPath,
      wikiPathSource: resolved.ok ? resolved.data.source : undefined,
      gitCheckPath,
      fleetLoad,
      readOnlyScanRoot,
      satelliteGate,
      mcpOnlyLeaf,
    };

    const rawChecks: CheckResult[] = [];
    for (const probe of this.probes) {
      const probeChecks = await probe.run(ctx);
      rawChecks.push(...probeChecks);
    }
    const checks = rawChecks.map((c) => ({
      ...c,
      detail: redactMcpSecret(c.detail, auth.token),
    }));

    const summary = {
      pass: checks.filter(c => c.status === "pass").length,
      info: checks.filter(c => c.status === "info").length,
      warn: checks.filter(c => c.status === "warn").length,
      error: checks.filter(c => c.status === "error").length,
    };

    const exitCode = summary.error > 0
      ? ExitCode.DOCTOR_HAS_ERRORS
      : summary.warn > 0
        ? ExitCode.DOCTOR_HAS_WARNINGS
        : ExitCode.OK;

    const statusIcon: Record<CheckStatus, string> = { pass: "✓", info: "i", warn: "⚠", error: "✗" };
    const lines = checks.map(c => {
      const icon = statusIcon[c.status];
      const padded = c.label.padEnd(24);
      return `  ${icon} ${padded} ${c.detail}`;
    });
    lines.push("");
    const summaryParts = [`${summary.pass} pass`];
    if (summary.info > 0) summaryParts.push(`${summary.info} info`);
    summaryParts.push(`${summary.warn} warn`, `${summary.error} error`);
    lines.push(summaryParts.join(" · "));
    const humanHint = redactMcpSecret(lines.join("\n"), auth.token);

    return { exitCode, result: ok({ checks, summary, humanHint }) };
  }
}

export async function runDoctor(
  input: DoctorInput
): Promise<{ exitCode: number; result: Result<DoctorOutput> }> {
  return new DoctorRunner().run(input);
}
