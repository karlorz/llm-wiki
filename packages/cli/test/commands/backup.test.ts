import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runBackupSync, runBackupRestore } from "../../src/commands/backup.js";

// Mock S3 client
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn((input: any) => input),
  HeadObjectCommand: vi.fn((input: any) => input),
  ListObjectsV2Command: vi.fn((input: any) => input),
  GetObjectCommand: vi.fn((input: any) => input),
  DeleteObjectsCommand: vi.fn((input: any) => input),
  NoSuchBucket: class extends Error { name = "NoSuchBucket"; },
  NoSuchKey: class extends Error { name = "NoSuchKey"; },
}));

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "backup-test-"));
  mkdirSync(join(dir, "raw/articles"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  writeFileSync(join(dir, "raw/articles/test.md"), "---\ningested: 2026-05-09\nsha256: abc123\n---\ncontent");
  writeFileSync(join(dir, "concepts/test-concept.md"), "---\ntitle: Test\ntype: concept\n---\nbody");
  return dir;
}

describe("backup sync", () => {
  afterEach(() => { mockSend.mockReset(); });

  it("uploads vault files to S3 bucket", async () => {
    const vault = makeVault();
    try {
      // HeadObject throws NoSuchKey (not on S3) → needs upload; PutObject succeeds
      // For 2 vault files: 2 HeadObject (reject) + 2 PutObject (resolve)
      mockSend
        .mockRejectedValueOnce({ name: "NoSuchKey" })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce({ name: "NoSuchKey" })
        .mockResolvedValueOnce({});
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.uploaded).toBeGreaterThan(0);
        expect(result.data.humanHint).toContain("uploaded");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("skips files that are unchanged on S3", async () => {
    const vault = makeVault();
    try {
      // HeadObject returns a future LastModified → local is NOT newer → skip
      const future = new Date(Date.now() + 60000);
      mockSend
        .mockResolvedValueOnce({ LastModified: future, ContentLength: 100 })
        .mockResolvedValueOnce({ LastModified: future, ContentLength: 100 });
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.uploaded).toBe(0);
        expect(result.data.skipped).toBeGreaterThan(0);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when auth is missing", async () => {
    const vault = makeVault();
    try {
      const { exitCode } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "",
        secretAccessKey: "",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("--dry-run lists actions without uploading", async () => {
    const vault = makeVault();
    try {
      mockSend
        .mockRejectedValueOnce({ name: "NoSuchKey" })
        .mockRejectedValueOnce({ name: "NoSuchKey" });
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
        dryRun: true,
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.dry_run).toBe(true);
        // dry-run should only call HeadObject, not PutObject
        // 2 HeadObject calls for 2 files, no PutObject calls
        expect(mockSend.mock.calls.length).toBe(2);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when only accessKeyId is missing", async () => {
    const vault = makeVault();
    try {
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "",
        secretAccessKey: "has-value",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
      if (!result.ok) {
        expect(result.error).toBe("BACKUP_SYNC_FAILED");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when only secretAccessKey is missing", async () => {
    const vault = makeVault();
    try {
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "has-value",
        secretAccessKey: "",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
      if (!result.ok) {
        expect(result.error).toBe("BACKUP_SYNC_FAILED");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("credential validation error includes guidance text", async () => {
    const vault = makeVault();
    try {
      const { result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "",
        secretAccessKey: "",
      });
      if (!result.ok) {
        expect(JSON.stringify(result.detail)).toContain("BACKUP_ACCESS_KEY_ID");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("prune mode deletes orphaned S3 objects and reports pruned count", async () => {
    const vault = makeVault();
    try {
      mockSend
        .mockRejectedValueOnce({ name: "NoSuchKey" }) // HeadObject file1
        .mockResolvedValueOnce({})                      // PutObject file1
        .mockRejectedValueOnce({ name: "NoSuchKey" }) // HeadObject file2
        .mockResolvedValueOnce({})                      // PutObject file2
        .mockResolvedValueOnce({                        // ListObjectsV2
          Contents: [
            { Key: "raw/articles/test.md" },
            { Key: "concepts/test-concept.md" },
            { Key: "old/deleted-file.md" },             // orphaned
          ],
        })
        .mockResolvedValueOnce({});                      // DeleteObjects
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
        prune: true,
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.pruned).toBe(1);
        expect(result.data.humanHint).toContain("pruned: 1");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("prune mode with no orphans reports pruned: 0", async () => {
    const vault = makeVault();
    try {
      const future = new Date(Date.now() + 60000);
      mockSend
        .mockResolvedValueOnce({ LastModified: future }) // HeadObject file1 - skip
        .mockResolvedValueOnce({ LastModified: future }) // HeadObject file2 - skip
        .mockResolvedValueOnce({                          // ListObjectsV2
          Contents: [
            { Key: "raw/articles/test.md" },
            { Key: "concepts/test-concept.md" },
          ],
        });
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
        prune: true,
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.pruned).toBe(0);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("prune does not delete objects in dry-run mode", async () => {
    const vault = makeVault();
    try {
      mockSend
        .mockRejectedValueOnce({ name: "NoSuchKey" }) // HeadObject file1
        .mockRejectedValueOnce({ name: "NoSuchKey" }); // HeadObject file2
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
        dryRun: true,
        prune: true,
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.pruned).toBe(0);
        expect(result.data.dry_run).toBe(true);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("partial upload failure returns BACKUP_SYNC_FAILED exit code", async () => {
    const vault = makeVault();
    try {
      mockSend
        .mockRejectedValueOnce({ name: "NoSuchKey" })        // HeadObject file1
        .mockResolvedValueOnce({})                             // PutObject file1 → success
        .mockRejectedValueOnce({ name: "NoSuchKey" })        // HeadObject file2
        .mockRejectedValueOnce(new Error("upload failed"));   // PutObject file2 → fail
      const { exitCode, result } = await runBackupSync({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
      if (result.ok) {
        expect(result.data.uploaded).toBe(1);
        expect(result.data.failed).toBe(1);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });
});

describe("backup restore", () => {
  afterEach(() => { mockSend.mockReset(); });

  it("downloads files from S3 to vault", async () => {
    const vault = makeVault();
    try {
      // ListObjectsV2 returns one object
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/restored.md", LastModified: new Date("2026-05-09") }],
      });
      // GetObjectCommand returns content
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => new TextEncoder().encode("---\ningested: 2026-05-09\nsha256: xyz\n---\nrestored content") },
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.downloaded).toBe(1);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("skips files where local is newer (conflict)", async () => {
    const vault = makeVault();
    try {
      // Local file has recent mtime → conflict
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/test.md", LastModified: new Date("2020-01-01") }],
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_RESTORE_CONFLICTS);
      if (result.ok) {
        expect(result.data.conflicts).toBe(1);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when credentials missing", async () => {
    const vault = makeVault();
    try {
      const { exitCode } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "",
        secretAccessKey: "",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("overwrites local files when S3 version is newer", async () => {
    const vault = makeVault();
    try {
      const future = new Date(Date.now() + 60000);
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/test.md", LastModified: future }],
      });
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => new TextEncoder().encode("---\ningested: 2026-05-09\nsha256: xyz\n---\nupdated content") },
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.downloaded).toBe(1);
        expect(result.data.conflicts).toBe(0);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("counts multiple conflicts and returns BACKUP_RESTORE_CONFLICTS", async () => {
    const vault = makeVault();
    try {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: "raw/articles/test.md", LastModified: new Date("2020-01-01") },
          { Key: "concepts/test-concept.md", LastModified: new Date("2020-01-01") },
        ],
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_RESTORE_CONFLICTS);
      if (result.ok) {
        expect(result.data.conflicts).toBe(2);
        expect(result.data.humanHint).toContain("conflicts: 2");
        expect(result.data.humanHint).toContain("local is newer");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("handles mix of downloads and conflicts", async () => {
    const vault = makeVault();
    try {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: "raw/articles/test.md", LastModified: new Date("2020-01-01") },      // exists locally, newer → conflict
          { Key: "entities/new-entity.md", LastModified: new Date("2020-01-01") },    // not local → download
        ],
      });
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => new TextEncoder().encode("---\ntitle: New\ntype: entity\n---\nnew content") },
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_RESTORE_CONFLICTS);
      if (result.ok) {
        expect(result.data.conflicts).toBe(1);
        expect(result.data.downloaded).toBe(1);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("restores to custom target directory", async () => {
    const vault = makeVault();
    const target = mkdtempSync(join(tmpdir(), "backup-restore-target-"));
    try {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/restored.md", LastModified: new Date("2026-05-09") }],
      });
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => new TextEncoder().encode("---\ningested: 2026-05-09\nsha256: xyz\n---\nrestored content") },
      });
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
        target,
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.downloaded).toBe(1);
      }
    } finally {
      rmSync(vault, { recursive: true });
      rmSync(target, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when listing bucket fails", async () => {
    const vault = makeVault();
    try {
      mockSend.mockRejectedValueOnce(new Error("Access Denied"));
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
      if (!result.ok) {
        expect(result.error).toBe("BACKUP_SYNC_FAILED");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("skips files on GetObject failure", async () => {
    const vault = makeVault();
    try {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/failing.md", LastModified: new Date("2026-05-09") }],
      });
      mockSend.mockRejectedValueOnce(new Error("network error"));
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(exitCode).toBe(ExitCode.OK);
      if (result.ok) {
        expect(result.data.skipped).toBe(1);
        expect(result.data.downloaded).toBe(0);
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("appends last-op entry on successful restore", async () => {
    const vault = makeVault();
    try {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: "raw/articles/restored.md", LastModified: new Date("2026-05-09") }],
      });
      mockSend.mockResolvedValueOnce({
        Body: { transformToByteArray: () => new TextEncoder().encode("---\ningested: 2026-05-09\nsha256: xyz\n---\nrestored content") },
      });
      await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      const lastOp = JSON.parse(readFileSync(join(vault, ".skillwiki", "last-op.json"), "utf8"));
      expect(lastOp).toHaveLength(1);
      expect(lastOp[0].operation).toBe("backup-restore");
      expect(lastOp[0].summary).toContain("restored 1 files");
    } finally {
      rmSync(vault, { recursive: true });
    }
  });

  it("returns BACKUP_SYNC_FAILED when only accessKeyId is missing for restore", async () => {
    const vault = makeVault();
    try {
      const { exitCode, result } = await runBackupRestore({
        vault,
        bucket: "test-bucket",
        endpoint: "http://localhost:8333",
        region: "us-east-1",
        accessKeyId: "",
        secretAccessKey: "has-value",
      });
      expect(exitCode).toBe(ExitCode.BACKUP_SYNC_FAILED);
      if (!result.ok) {
        expect(result.error).toBe("BACKUP_SYNC_FAILED");
      }
    } finally {
      rmSync(vault, { recursive: true });
    }
  });
});
