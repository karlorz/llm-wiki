import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ok, err, type Result } from "@skillwiki/shared";

const execFileAsync = promisify(execFile);

export interface RcloneResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RcloneRunner = (args: string[]) => Promise<RcloneResult>;

export interface RemotePruneResult {
  plannedDeletes: string[];
  deleted: string[];
}

export interface RemotePruneInput {
  remote?: string;
  remoteDelete?: boolean;
  maxRemoteDeletes?: number;
  rcloneRunner?: RcloneRunner;
  /** Default cap when `maxRemoteDeletes` is unset. Defaults to 1. */
  defaultMaxDeletes?: number;
}

/**
 * Strip trailing slashes from a rclone remote root, e.g.
 * `seaweed-wiki:cloud/wiki/` → `seaweed-wiki:cloud/wiki`. Returns undefined
 * when no remote was supplied.
 */
export function normalizeRemoteRoot(remote?: string): string | undefined {
  return remote?.replace(/\/+$/, "");
}

/**
 * Build the rclone object path for a vault-relative path under a remote root.
 * Returns undefined when there is no remote root.
 */
export function buildRemoteObjectPath(remoteRoot: string | undefined, relPath: string): string | undefined {
  return remoteRoot ? `${remoteRoot}/${relPath}` : undefined;
}

/**
 * Validate the `--max-remote-deletes` cap. `undefined` is valid (caller applies
 * its own default); non-positive or non-integer values are invalid.
 */
export function isValidRemoteDeleteCap(maxRemoteDeletes: number | undefined): boolean {
  if (maxRemoteDeletes === undefined) return true;
  return Number.isInteger(maxRemoteDeletes) && maxRemoteDeletes > 0;
}

/**
 * Plan and optionally execute bounded rclone `deletefile` calls against a list
 * of remote object paths. When `remoteDelete` is false, returns the planned
 * paths without invoking rclone. The `maxRemoteDeletes` cap is enforced before
 * any deletion; a `USAGE` error is returned when it is exceeded or invalid.
 *
 * On rclone failure, returns `SYNC_PUSH_FAILED` with the offending path and
 * stderr in `detail`; any deletions that succeeded before the failure are
 * recorded in `result.data.deleted` (best-effort, not retried).
 */
export async function planAndMaybePruneRemoteObjects(
  plannedDeletes: string[],
  input: RemotePruneInput,
): Promise<Result<RemotePruneResult>> {
  const output: RemotePruneResult = { plannedDeletes, deleted: [] };

  if (!input.remoteDelete) return ok(output);

  const maxDeletes = input.maxRemoteDeletes ?? input.defaultMaxDeletes ?? 1;
  if (!Number.isInteger(maxDeletes) || maxDeletes < 1) {
    return err("USAGE", { message: "--max-remote-deletes must be a positive integer" });
  }
  if (plannedDeletes.length > maxDeletes) {
    return err("USAGE", { message: `remote delete cap exceeded: ${plannedDeletes.length} > ${maxDeletes}` });
  }

  const runner = input.rcloneRunner ?? defaultRcloneRunner;
  for (const path of plannedDeletes) {
    const result = await runner(["deletefile", path]);
    if (result.exitCode !== 0) {
      return err("SYNC_PUSH_FAILED", { path, stderr: result.stderr, deleted: output.deleted });
    }
    output.deleted.push(path);
  }

  return ok(output);
}

export async function defaultRcloneRunner(args: string[]): Promise<RcloneResult> {
  try {
    const result = await execFileAsync("rclone", args, { encoding: "utf-8" });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (e: any) {
    return {
      exitCode: typeof e?.code === "number" ? e.code : 1,
      stdout: typeof e?.stdout === "string" ? e.stdout : "",
      stderr: typeof e?.stderr === "string" ? e.stderr : String(e),
    };
  }
}
