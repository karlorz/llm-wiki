import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
});
