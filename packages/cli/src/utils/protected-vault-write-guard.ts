import { err, ExitCode, type ErrResult } from "@skillwiki/shared";
import { loadFleetManifestAndHost } from "../commands/fleet.js";

export interface ProtectedVaultWriteGuardInput {
  vault: string;
  command: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
  osHostname?: string;
  user?: string;
}

export interface ProtectedVaultWriteGuardBlocked {
  blocked: true;
  exitCode: number;
  result: ErrResult;
}

export interface ProtectedVaultWriteGuardAllowed {
  blocked: false;
}

export type ProtectedVaultWriteGuardResult =
  | ProtectedVaultWriteGuardBlocked
  | ProtectedVaultWriteGuardAllowed;

export async function guardProtectedVaultWrite(
  input: ProtectedVaultWriteGuardInput
): Promise<ProtectedVaultWriteGuardResult> {
  const load = await loadFleetManifestAndHost({
    vault: input.vault,
    hostId: input.hostId,
    env: input.env ?? process.env,
    home: input.home ?? process.env.HOME ?? "",
    cwd: input.cwd ?? process.cwd(),
    osHostname: input.osHostname ?? process.env.HOSTNAME,
    user: input.user ?? process.env.USER,
  });

  if (!load?.hostId || load.identityStatus !== "known") {
    return { blocked: false };
  }

  const host = load.manifest.hosts[load.hostId];
  if (!host || host.role !== "snapshotter" || host.protected !== true) {
    return { blocked: false };
  }

  return {
    blocked: true,
    exitCode: ExitCode.PROTECTED_SNAPSHOTTER_WRITE_BLOCKED,
    result: err("PROTECTED_SNAPSHOTTER_WRITE_BLOCKED", {
      host_id: load.hostId,
      command: input.command,
      reason: `refusing vault mutation from protected snapshotter host '${load.hostId}'`,
      guidance: "Use a leaf authoring host for vault/project writes. Keep protected snapshotter sessions read-only except explicit snapshot maintenance.",
    }),
  };
}
