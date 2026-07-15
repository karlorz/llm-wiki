import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { atomicWriteText } from "../utils/atomic-write.js";
import { readLogEvents } from "../utils/log-events.js";
import { renderLogProjection } from "../utils/log-projection.js";
import { resolveProjectionAuthority } from "../utils/projection-authority.js";
import { guardProtectedVaultWrite } from "../utils/protected-vault-write-guard.js";
import { loadFleetManifestAndHost } from "./fleet.js";

export interface LogMaterializeInput {
  vault: string;
  write: boolean;
  hostId?: string;
  skipAuthority?: boolean;
}

export interface LogMaterializeOutput {
  changed: boolean;
  dry_run: boolean;
  event_count: number;
  humanHint: string;
}

export async function runLogMaterialize(
  input: LogMaterializeInput,
): Promise<{ exitCode: number; result: Result<LogMaterializeOutput> }> {
  const events = await readLogEvents(input.vault);
  if (!events.ok) {
    return { exitCode: ExitCode.SCHEME_REJECTED, result: events };
  }
  const text = renderLogProjection(events.data);
  let current = "";
  try {
    current = readFileSync(join(input.vault, "log.md"), "utf8");
  } catch {
    current = "";
  }
  const changed = current !== text;
  if (!input.write) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        changed,
        dry_run: true,
        event_count: events.data.length,
        humanHint: changed
          ? `dry run: would rewrite log.md (${events.data.length} events)`
          : `dry run: log.md already canonical (${events.data.length} events)`,
      }),
    };
  }

  if (!input.skipAuthority) {
    const fleet = await loadFleetManifestAndHost({ vault: input.vault, hostId: input.hostId });
    const auth = resolveProjectionAuthority(fleet);
    if (!auth.ok) return { exitCode: ExitCode.PREFLIGHT_FAILED, result: auth };
    if (!auth.data.can_write) {
      return {
        exitCode: ExitCode.PREFLIGHT_FAILED,
        result: err("PREFLIGHT_FAILED", {
          reason: "projection-authority",
          authority_host_id: auth.data.authority_host_id,
          current_host_id: auth.data.current_host_id,
        }),
      };
    }
    const guard = await guardProtectedVaultWrite({ vault: input.vault, command: "log materialize" });
    if (guard.blocked) return { exitCode: guard.exitCode, result: guard.result };
  }

  if (!changed) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        changed: false,
        dry_run: false,
        event_count: events.data.length,
        humanHint: `log.md already canonical (${events.data.length} events)`,
      }),
    };
  }
  const written = await atomicWriteText(join(input.vault, "log.md"), text);
  if (!written.ok) return { exitCode: ExitCode.WRITE_FAILED, result: written };
  const installed = readFileSync(join(input.vault, "log.md"), "utf8");
  if (installed !== text) {
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: err("WRITE_FAILED", { message: "installed log.md differs from projection" }),
    };
  }
  return {
    exitCode: ExitCode.OK,
    result: ok({
      changed: true,
      dry_run: false,
      event_count: events.data.length,
      humanHint: `rewrote log.md (${events.data.length} events)`,
    }),
  };
}
