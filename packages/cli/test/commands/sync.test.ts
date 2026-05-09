import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runSyncStatus, runSyncPush, runSyncPull } from "../../src/commands/sync.js";
import { appendLastOp } from "../../src/utils/last-op.js";
import { existsSync } from "node:fs";

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}

describe("runSyncStatus", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  it("reports not_a_repo for directory without git", () => {
    const dir = makeTempDir();
    const { exitCode, result } = runSyncStatus({ vault: dir });
    expect(exitCode).toBe(ExitCode.VAULT_PATH_INVALID); // 9
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("not_a_repo");
      expect(result.data.is_git_repo).toBe(false);
      expect(result.data.last_commit).toBe("never");
    }
  });

  it("reports clean for clean git repo", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    const { exitCode, result } = runSyncStatus({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK); // 0
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("clean");
      expect(result.data.is_git_repo).toBe(true);
      expect(result.data.dirty).toBe(0);
      expect(result.data.ahead).toBe(0);
    }
  });

  it("reports dirty when uncommitted changes", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    // Introduce uncommitted change
    writeFileSync(join(dir, "README.md"), "modified");
    const { exitCode, result } = runSyncStatus({ vault: dir });
    expect(exitCode).toBe(ExitCode.LINT_HAS_WARNINGS); // 22
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("dirty");
      expect(result.data.dirty).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports ahead when commits not pushed", () => {
    // Set up a bare remote, clone it, push initial commit, then add another locally
    const remoteDir = makeTempDir();
    git(remoteDir, "init --bare");
    const dir = makeTempDir();
    git(dir, `clone ${remoteDir} .`);
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    git(dir, "branch -M main");
    git(dir, "push -u origin main");
    git(dir, "remote set-head origin main");
    // Second local-only commit (ahead of origin)
    writeFileSync(join(dir, "extra.txt"), "more");
    git(dir, "add .");
    git(dir, 'commit -m second');
    const { exitCode, result } = runSyncStatus({ vault: dir });
    expect(exitCode).toBe(ExitCode.LINT_HAS_WARNINGS); // 22
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("ahead");
      expect(result.data.ahead).toBeGreaterThanOrEqual(1);
    }
  });

  it("includes last_commit timestamp", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    const { result } = runSyncStatus({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.last_commit).not.toBe("never");
      // Verify it is a valid ISO date string
      const parsed = Date.parse(result.data.last_commit);
      expect(isNaN(parsed)).toBe(false);
    }
  });
});

describe("runSyncPush", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  it("returns error when no remote configured", async () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    // Add a new file so working tree is dirty
    writeFileSync(join(dir, "new.txt"), "data");
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pushed).toBe(false);
      expect(result.data.files_committed).toBeGreaterThanOrEqual(1);
    }
  });

  it("returns OK with nothing to commit when working tree clean", async () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    // Working tree is clean — no changes
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files_committed).toBe(0);
      expect(result.data.pushed).toBe(false);
    }
  });

  it("returns NOT_A_GIT_REPO for non-git directory", async () => {
    const dir = makeTempDir();
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(result.ok).toBe(false);
  });

  it("uses last-op entries for commit message when present", async () => {
    const dir = makeTempDir();
    git(dir, "init -b main");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "initial.txt"), "init");
    git(dir, "add .");
    git(dir, "commit -m init");
    // Create a dirty file
    mkdirSync(join(dir, "raw/articles"), { recursive: true });
    writeFileSync(join(dir, "raw/articles/test.md"), "content");
    // Write last-op
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    appendLastOp(dir, { operation: "ingest", summary: "added test-concept", files: ["raw/articles/test.md", "concepts/test.md"], timestamp: "2026-05-09T04:00:00Z" });
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED); // no remote
    if (result.ok) {
      expect(result.data.commit_message).toBe("ingest: added test-concept (2 files)");
    }
    // last-op should be deleted after commit
    expect(existsSync(join(dir, ".skillwiki", "last-op.json"))).toBe(false);
  });

  it("falls back to timestamp commit when no last-op", async () => {
    const dir = makeTempDir();
    git(dir, "init -b main");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "initial.txt"), "init");
    git(dir, "add .");
    git(dir, "commit -m init");
    mkdirSync(join(dir, "raw/articles"), { recursive: true });
    writeFileSync(join(dir, "raw/articles/test.md"), "content");
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED); // no remote, but commit succeeds
    if (result.ok) {
      expect(result.data.commit_message).toMatch(/^sync: vault update /);
    }
  });

  it("merges multiple last-op entries into one commit", async () => {
    const dir = makeTempDir();
    git(dir, "init -b main");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "initial.txt"), "init");
    git(dir, "add .");
    git(dir, "commit -m init");
    mkdirSync(join(dir, "raw/articles"), { recursive: true });
    writeFileSync(join(dir, "raw/articles/test.md"), "content");
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    appendLastOp(dir, { operation: "ingest", summary: "added test-concept", files: ["raw/articles/test.md"], timestamp: "2026-05-09T04:00:00Z" });
    appendLastOp(dir, { operation: "archive", summary: "moved old-page", files: ["concepts/old.md"], timestamp: "2026-05-09T04:01:00Z" });
    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED); // no remote
    if (result.ok) {
      expect(result.data.commit_message).toBe("ingest: added test-concept (1 files); archive: moved old-page (1 files)");
    }
  });
});

describe("runSyncPull", () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    tmpDirs = [];
  });

  it("returns error when no remote configured", async () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, 'commit -m init');
    const { exitCode, result } = await runSyncPull({ vault: dir });
    expect(exitCode).toBe(ExitCode.SYNC_PULL_FAILED);
    expect(result.ok).toBe(false);
  });

  it("returns NOT_A_GIT_REPO for non-git directory", async () => {
    const dir = makeTempDir();
    const { exitCode, result } = await runSyncPull({ vault: dir });
    expect(exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(result.ok).toBe(false);
  });

  it("pulls from remote and reports files updated", async () => {
    // Set up a bare remote with initial content
    const remoteDir = makeTempDir();
    git(remoteDir, "init --bare");
    // Create a clone, add content, push
    const cloneDir = makeTempDir();
    git(cloneDir, `clone ${remoteDir} .`);
    git(cloneDir, 'config user.email "t@t"');
    git(cloneDir, 'config user.name "t"');
    // Need at least one file to push
    writeFileSync(join(cloneDir, "README.md"), "hello");
    git(cloneDir, "add .");
    git(cloneDir, 'commit -m init');
    git(cloneDir, "branch -M main");
    git(cloneDir, "push -u origin main");
    // Now create a second clone to simulate a second client pushing changes
    const clientADir = makeTempDir();
    git(clientADir, `clone ${remoteDir} .`);
    git(clientADir, 'config user.email "t@t"');
    git(clientADir, 'config user.name "t"');
    // Push a change from client A
    mkdirSync(join(clientADir, "raw"), { recursive: true });
    mkdirSync(join(clientADir, "raw", "transcripts"), { recursive: true });
    writeFileSync(join(clientADir, "raw", "transcripts", "test.md"), "---\ntitle: test\n---\nbody");
    git(clientADir, "add .");
    git(clientADir, 'commit -m "add transcript"');
    git(clientADir, "branch -M main");
    git(clientADir, "push origin main");
    // Now pull from the first clone
    const { exitCode, result } = await runSyncPull({ vault: cloneDir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fetched).toBe(true);
      expect(result.data.pulled).toBe(true);
    }
  });
});
