import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode, err, ok, type Result } from "@skillwiki/shared";
import { atomicWriteText, type AtomicWriteOutput } from "../utils/atomic-write.js";
import { renderRootIndex } from "../utils/index-projection.js";
import { readLogEvents } from "../utils/log-events.js";
import { renderLogProjection } from "../utils/log-projection.js";
import { resolveProjectionAuthority } from "../utils/projection-authority.js";
import { loadFleetManifestAndHost } from "./fleet.js";

export interface ProjectionMaterializeDeps {
  writeText(path: string, text: string): Promise<Result<AtomicWriteOutput>>;
}

export interface ProjectionsMaterializeInput {
  vault: string;
  write: boolean;
  hostId?: string;
}

export interface ProjectionsMaterializeOutput {
  authority_host_id: string;
  current_host_id?: string;
  can_write: boolean;
  index_changed: boolean;
  log_changed: boolean;
  index_drift: boolean;
  log_drift: boolean;
  rolled_back: boolean;
  dry_run: boolean;
  humanHint: string;
}

const defaultDeps: ProjectionMaterializeDeps = {
  writeText: (path, text) => atomicWriteText(path, text),
};

export async function runProjectionsMaterialize(
  input: ProjectionsMaterializeInput,
  deps: ProjectionMaterializeDeps = defaultDeps,
): Promise<{ exitCode: number; result: Result<ProjectionsMaterializeOutput> }> {
  const fleet = await loadFleetManifestAndHost({ vault: input.vault, hostId: input.hostId });
  const auth = resolveProjectionAuthority(fleet);
  if (!auth.ok) return { exitCode: ExitCode.PREFLIGHT_FAILED, result: auth };

  const indexProj = await renderRootIndex({ vault: input.vault });
  if (!indexProj.ok) return { exitCode: ExitCode.SCHEME_REJECTED, result: indexProj };
  const events = await readLogEvents(input.vault);
  if (!events.ok) return { exitCode: ExitCode.SCHEME_REJECTED, result: events };
  const logText = renderLogProjection(events.data);

  let curIndex = "";
  let curLog = "";
  try { curIndex = readFileSync(join(input.vault, "index.md"), "utf8"); } catch { /* empty */ }
  try { curLog = readFileSync(join(input.vault, "log.md"), "utf8"); } catch { /* empty */ }

  const indexDrift = curIndex !== indexProj.data.text;
  const logDrift = curLog !== logText;

  if (!input.write) {
    return {
      exitCode: ExitCode.OK,
      result: ok({
        authority_host_id: auth.data.authority_host_id,
        current_host_id: auth.data.current_host_id,
        can_write: auth.data.can_write,
        index_changed: false,
        log_changed: false,
        index_drift: indexDrift,
        log_drift: logDrift,
        rolled_back: false,
        dry_run: true,
        humanHint: `dry run: index_drift=${indexDrift} log_drift=${logDrift} can_write=${auth.data.can_write}`,
      }),
    };
  }

  if (!auth.data.can_write) {
    return {
      exitCode: ExitCode.PREFLIGHT_FAILED,
      result: err("PREFLIGHT_FAILED", {
        reason: "projection-authority",
        authority_host_id: auth.data.authority_host_id,
        current_host_id: auth.data.current_host_id,
        index_drift: indexDrift,
        log_drift: logDrift,
      }),
    };
  }

  const indexPath = join(input.vault, "index.md");
  const logPath = join(input.vault, "log.md");
  const indexWrite = await deps.writeText(indexPath, indexProj.data.text);
  if (!indexWrite.ok) return { exitCode: ExitCode.WRITE_FAILED, result: indexWrite };
  const logWrite = await deps.writeText(logPath, logText);
  if (!logWrite.ok) {
    // rollback index
    await deps.writeText(indexPath, curIndex);
    return {
      exitCode: ExitCode.WRITE_FAILED,
      result: ok({
        authority_host_id: auth.data.authority_host_id,
        current_host_id: auth.data.current_host_id,
        can_write: true,
        index_changed: false,
        log_changed: false,
        index_drift: indexDrift,
        log_drift: logDrift,
        rolled_back: true,
        dry_run: false,
        humanHint: "projection materialize rolled back after log write failure",
      }),
    };
  }

  return {
    exitCode: ExitCode.OK,
    result: ok({
      authority_host_id: auth.data.authority_host_id,
      current_host_id: auth.data.current_host_id,
      can_write: true,
      index_changed: indexWrite.data.changed,
      log_changed: logWrite.data.changed,
      index_drift: indexDrift,
      log_drift: logDrift,
      rolled_back: false,
      dry_run: false,
      humanHint: `materialized projections index_changed=${indexWrite.data.changed} log_changed=${logWrite.data.changed}`,
    }),
  };
}
