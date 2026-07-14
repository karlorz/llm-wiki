import { unlink, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { scanVault } from "../utils/vault.js";
import { appendLastOp } from "../utils/last-op.js";
import {
  normalizeRemoteRoot,
  buildRemoteObjectPath,
  isValidRemoteDeleteCap,
  planAndMaybePruneRemoteObjects,
  type RcloneRunner,
  type RemotePruneResult,
} from "../utils/rclone.js";
import {
  buildDeleteIntent,
  writeDeleteIntent,
  normalizeVaultRelPath,
} from "../utils/delete-intent.js";

export interface RemoveInput {
  vault: string;
  page: string;
  remote?: string;
  remoteDelete?: boolean;
  maxRemoteDeletes?: number;
  reason?: string;
  rcloneRunner?: RcloneRunner;
}

export interface RemoveOutput {
  removed: string;
  tombstone_path: string;
  index_updated: boolean;
  remote?: RemotePruneResult;
  humanHint: string;
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function runRemove(input: RemoveInput): Promise<{ exitCode: number; result: Result<RemoveOutput> }> {
  if (input.remoteDelete && !input.remote) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--remote-delete requires --remote" }) };
  }
  if (input.remoteDelete && !isValidRemoteDeleteCap(input.maxRemoteDeletes)) {
    return { exitCode: ExitCode.USAGE, result: err("USAGE", { message: "--max-remote-deletes must be a positive integer" }) };
  }

  const scan = await scanVault(input.vault);
  if (!scan.ok) return { exitCode: ExitCode.VAULT_PATH_INVALID, result: scan };

  const lookup = (pages: { relPath: string }[]) => {
    if (input.page.includes("/")) return pages.find(p => p.relPath === input.page)?.relPath;
    return pages.find(p => p.relPath.replace(/\.md$/, "").split("/").pop() === input.page)?.relPath;
  };

  let relPath = lookup(scan.data.typedKnowledge) ?? lookup(scan.data.raw) ?? null;

  if (!relPath) {
    try {
      const candidate = normalizeVaultRelPath(input.page);
      if (await pathExists(join(input.vault, candidate))) {
        relPath = candidate;
      }
    } catch {
      /* invalid path handled below */
    }
  }

  if (!relPath) {
    return {
      exitCode: ExitCode.FILE_NOT_FOUND,
      result: err("FILE_NOT_FOUND", { page: input.page }),
    };
  }

  if (relPath.startsWith("_archive/")) {
    return {
      exitCode: ExitCode.USAGE,
      result: err("USAGE", { message: "refusing to remove path already under _archive/; use restore or leave archived" }),
    };
  }

  // Remote flags already validated; planAndMaybePruneRemoteObjects enforces the cap.
  // Single-path remove never exceeds default cap 1 after isValidRemoteDeleteCap.
  const remoteRoot = normalizeRemoteRoot(input.remote);
  const remoteObjectPath = buildRemoteObjectPath(remoteRoot, relPath);

  const slug = relPath.replace(/\.md$/, "").split("/").pop() ?? relPath;
  let indexUpdated = false;
  if (relPath.endsWith(".md") && !relPath.startsWith("raw/")) {
    const indexPath = join(input.vault, "index.md");
    try {
      const idx = await readFile(indexPath, "utf8");
      const originalLines = idx.split("\n");
      const filtered = originalLines.filter(l => !l.includes(`[[${slug}]]`));
      if (filtered.length !== originalLines.length) {
        await writeFile(indexPath, filtered.join("\n"), "utf8");
        indexUpdated = true;
      }
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && e.code !== "ENOENT") throw e;
    }
  }

  const intent = buildDeleteIntent({
    path: relPath,
    action: "remove",
    actor: "skillwiki-cli",
    source: "cli",
    reason: input.reason,
  });
  const tombstonePath = await writeDeleteIntent(input.vault, intent);

  await unlink(join(input.vault, relPath));

  appendLastOp(input.vault, {
    operation: "remove",
    summary: `removed ${relPath} (tombstone ${tombstonePath})`,
    files: [relPath, tombstonePath],
    timestamp: new Date().toISOString(),
  });

  let remote: RemotePruneResult | undefined;
  if (remoteObjectPath) {
    const pruned = await planAndMaybePruneRemoteObjects([remoteObjectPath], input);
    if (!pruned.ok) {
      return { exitCode: ExitCode.SYNC_PUSH_FAILED, result: pruned };
    }
    remote = pruned.data;
  }

  const remoteNote = remote
    ? ` (remote ${input.remoteDelete ? `deleted ${remote.deleted.length}` : `planned ${remote.plannedDeletes.length}`})`
    : "";

  return {
    exitCode: ExitCode.OK,
    result: ok({
      removed: relPath,
      tombstone_path: tombstonePath,
      index_updated: indexUpdated,
      ...(remote ? { remote } : {}),
      humanHint: `removed ${relPath}; tombstone ${tombstonePath}${indexUpdated ? " (index updated)" : ""}${remoteNote}`,
    }),
  };
}
