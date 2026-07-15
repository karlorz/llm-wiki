import { err, ok, type Result } from "@skillwiki/shared";
import type { FleetManifestAndHost } from "../commands/fleet.js";

export interface ProjectionAuthority {
  authority_host_id: string;
  current_host_id?: string;
  can_write: boolean;
}

export function resolveProjectionAuthority(
  load: FleetManifestAndHost | null,
): Result<ProjectionAuthority> {
  if (!load) {
    // No fleet: treat as standalone writer-local authority.
    return ok({ authority_host_id: "standalone", current_host_id: "standalone", can_write: true });
  }
  const snapshotters = Object.entries(load.manifest.hosts)
    .filter(([, h]) => h.role === "snapshotter")
    .map(([id]) => id);
  const configured = (load.manifest as { projection_authority?: string }).projection_authority;
  let authority = configured;
  if (!authority) {
    if (snapshotters.length === 1) authority = snapshotters[0];
    else {
      return err("PREFLIGHT_FAILED", {
        reason: "projection-authority-unresolved",
        snapshotters,
      });
    }
  }
  if (!load.manifest.hosts[authority]) {
    return err("PREFLIGHT_FAILED", { reason: "projection-authority-unknown-host", authority });
  }
  if (load.identityStatus !== "known" || !load.hostId) {
    return err("PREFLIGHT_FAILED", {
      reason: "fleet-identity-unresolved",
      identity_status: load.identityStatus,
    });
  }
  return ok({
    authority_host_id: authority,
    current_host_id: load.hostId,
    can_write: load.hostId === authority,
  });
}
