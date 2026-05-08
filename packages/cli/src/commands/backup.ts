import { statSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { ok, err, ExitCode, type Result } from "@skillwiki/shared";
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { createS3Client, type BackupConfig } from "../utils/s3-client.js";
import { appendLastOp } from "../utils/last-op.js";

// ── Types ────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", ".obsidian", "_archive", "node_modules", ".skillwiki"]);

export interface BackupSyncInput {
  vault: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  dryRun?: boolean;
  prune?: boolean;
}

export interface BackupSyncOutput {
  scanned: number;
  uploaded: number;
  skipped: number;
  failed: number;
  pruned: number;
  dry_run: boolean;
  humanHint: string;
}

export interface BackupRestoreInput {
  vault: string;
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  target?: string;
}

export interface BackupRestoreOutput {
  downloaded: number;
  skipped: number;
  conflicts: number;
  humanHint: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function* walkMarkdown(dir: string, base: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(full, base);
    } else if (entry.name.endsWith(".md")) {
      yield relative(base, full);
    }
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────

export async function runBackupSync(
  input: BackupSyncInput
): Promise<{ exitCode: number; result: Result<BackupSyncOutput> }> {
  if (!input.accessKeyId || !input.secretAccessKey) {
    return {
      exitCode: ExitCode.BACKUP_SYNC_FAILED,
      result: err("BACKUP_SYNC_FAILED", {
        message: "Backup credentials not configured. Run: skillwiki config set BACKUP_ACCESS_KEY_ID <key>",
      }),
    };
  }

  const client = createS3Client(input);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  const files = [...walkMarkdown(input.vault, input.vault)];

  for (const relPath of files) {
    const absPath = join(input.vault, relPath);
    const localStat = statSync(absPath);

    // Check if object exists on S3 and is up to date
    let needsUpload = true;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: relPath }));
      if (head.LastModified && head.LastModified >= localStat.mtime) {
        needsUpload = false;
      }
    } catch {
      // Object doesn't exist → needs upload
    }

    if (!needsUpload) {
      skipped++;
      continue;
    }

    if (input.dryRun) {
      uploaded++; // Count what would be uploaded
      continue;
    }

    try {
      const body = readFileSync(absPath);
      await client.send(new PutObjectCommand({ Bucket: input.bucket, Key: relPath, Body: body }));
      uploaded++;
    } catch {
      failed++;
    }
  }

  // Prune orphaned objects
  let pruned = 0;
  if (input.prune && !input.dryRun) {
    try {
      const localSet = new Set(files);
      const list = await client.send(new ListObjectsV2Command({ Bucket: input.bucket }));
      const toDelete = (list.Contents ?? [])
        .filter(obj => obj.Key && !localSet.has(obj.Key))
        .map(obj => ({ Key: obj.Key! }));
      if (toDelete.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: input.bucket, Delete: { Objects: toDelete } }));
        pruned = toDelete.length;
      }
    } catch {
      // Best-effort prune
    }
  }

  const hintParts: string[] = [];
  if (input.dryRun) hintParts.push("DRY RUN —");
  hintParts.push(`scanned: ${files.length}, uploaded: ${uploaded}, skipped: ${skipped}`);
  if (failed > 0) hintParts.push(`failed: ${failed}`);
  if (pruned > 0) hintParts.push(`pruned: ${pruned}`);

  return {
    exitCode: failed > 0 ? ExitCode.BACKUP_SYNC_FAILED : ExitCode.OK,
    result: ok({
      scanned: files.length,
      uploaded,
      skipped,
      failed,
      pruned,
      dry_run: input.dryRun ?? false,
      humanHint: hintParts.join(", "),
    }),
  };
}

// ── Restore ──────────────────────────────────────────────────────────────

export async function runBackupRestore(
  input: BackupRestoreInput
): Promise<{ exitCode: number; result: Result<BackupRestoreOutput> }> {
  if (!input.accessKeyId || !input.secretAccessKey) {
    return {
      exitCode: ExitCode.BACKUP_SYNC_FAILED,
      result: err("BACKUP_SYNC_FAILED", {
        message: "Backup credentials not configured. Run: skillwiki config set BACKUP_ACCESS_KEY_ID <key>",
      }),
    };
  }

  const client = createS3Client(input);
  const target = input.target ?? input.vault;
  let downloaded = 0;
  let skipped = 0;
  let conflicts = 0;

  try {
    const list = await client.send(new ListObjectsV2Command({ Bucket: input.bucket }));
    const objects = list.Contents ?? [];

    for (const obj of objects) {
      if (!obj.Key) continue;
      const localPath = join(target, obj.Key);

      // Skip if local file is newer
      try {
        const localStat = statSync(localPath);
        if (obj.LastModified && localStat.mtime > obj.LastModified) {
          conflicts++;
          continue;
        }
        // File exists and is older → overwrite
      } catch {
        // File doesn't exist → download
      }

      try {
        const resp = await client.send(new GetObjectCommand({ Bucket: input.bucket, Key: obj.Key }));
        const body = await resp.Body?.transformToByteArray();
        if (body) {
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, Buffer.from(body));
          downloaded++;
        }
      } catch {
        skipped++;
      }
    }
  } catch (e: any) {
    return {
      exitCode: ExitCode.BACKUP_SYNC_FAILED,
      result: err("BACKUP_SYNC_FAILED", { message: `Failed to list bucket: ${String(e)}` }),
    };
  }

  const hintParts: string[] = [`downloaded: ${downloaded}`];
  if (skipped > 0) hintParts.push(`skipped: ${skipped}`);
  if (conflicts > 0) hintParts.push(`conflicts: ${conflicts} (local is newer)`);

  // Append last-op for restore
  if (downloaded > 0) {
    appendLastOp(target, {
      operation: "backup-restore",
      summary: `restored ${downloaded} files from S3`,
      files: [], // Don't enumerate potentially hundreds of files
      timestamp: new Date().toISOString(),
    });
  }

  return {
    exitCode: conflicts > 0 ? ExitCode.BACKUP_RESTORE_CONFLICTS : ExitCode.OK,
    result: ok({ downloaded, skipped, conflicts, humanHint: hintParts.join(", ") }),
  };
}
