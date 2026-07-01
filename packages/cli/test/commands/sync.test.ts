import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "@skillwiki/shared";
import { runSyncStatus, runSyncPush, runSyncPull, runSyncLock, runSyncUnlock, runSyncPeers } from "../../src/commands/sync.js";
import { appendLastOp } from "../../src/utils/last-op.js";

let tmpDirs: string[] = [];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const cliEntry = join(repoRoot, "packages/cli/dist/cli.js");

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, cmd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}

function cliEnvWithoutSession(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_SESSION_ID;
  delete env.SKILLWIKI_SESSION_ID;
  return env;
}

function runSkillwikiCli(args: string[]): string {
  return execFileSync(
    process.execPath,
    [cliEntry, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: cliEnvWithoutSession(),
      stdio: "pipe",
    },
  );
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
    git(dir, "config core.longpaths true");
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

  it("does not include dirty derived memory caches in sync commits", async () => {
    const dir = makeTempDir();
    git(dir, "init -b main");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "initial.txt"), "init");
    mkdirSync(join(dir, ".skillwiki", "memory", "llm-wiki"), { recursive: true });
    writeFileSync(join(dir, ".skillwiki", "memory", "llm-wiki", "topics.json"), "old-cache\n");
    git(dir, "add .");
    git(dir, "commit -m init");

    writeFileSync(join(dir, ".skillwiki", "memory", "llm-wiki", "topics.json"), "new-cache\n");
    mkdirSync(join(dir, "raw/articles"), { recursive: true });
    writeFileSync(join(dir, "raw/articles/test.md"), "content");

    const { exitCode } = await runSyncPush({ vault: dir });

    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED); // no remote, but commit succeeds
    const committedCache = execSync("git show HEAD:.skillwiki/memory/llm-wiki/topics.json", { cwd: dir, encoding: "utf8" });
    expect(committedCache).toBe("old-cache\n");
    const committedArticle = execSync("git show HEAD:raw/articles/test.md", { cwd: dir, encoding: "utf8" });
    expect(committedArticle).toBe("content");
  });

  it("commits content changes when generated skillwiki paths are ignored", async () => {
    const dir = makeTempDir();
    git(dir, "init -b main");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, ".gitignore"), ".skillwiki/memory/\n.skillwiki/memory-topics.json\n");
    writeFileSync(join(dir, "initial.txt"), "init");
    git(dir, "add .");
    git(dir, "commit -m init");

    mkdirSync(join(dir, ".skillwiki", "memory", "llm-wiki"), { recursive: true });
    writeFileSync(join(dir, ".skillwiki", "memory", "llm-wiki", "topics.json"), "ignored-cache\n");
    writeFileSync(join(dir, ".skillwiki", "memory-topics.json"), "ignored-topics\n");
    mkdirSync(join(dir, "raw/articles"), { recursive: true });
    writeFileSync(join(dir, "raw/articles/test.md"), "content");

    const { exitCode } = await runSyncPush({ vault: dir });

    expect(exitCode).toBe(ExitCode.SYNC_PUSH_FAILED); // no remote, but commit succeeds
    const committedArticle = execSync("git show HEAD:raw/articles/test.md", { cwd: dir, encoding: "utf8" });
    expect(committedArticle).toBe("content");
    expect(() => execSync("git cat-file -e HEAD:.skillwiki/memory/llm-wiki/topics.json", { cwd: dir, stdio: "ignore" })).toThrow();
    expect(() => execSync("git cat-file -e HEAD:.skillwiki/memory-topics.json", { cwd: dir, stdio: "ignore" })).toThrow();
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

  it("auto-fixes long markdown paths before staging vault changes", async () => {
    const remoteDir = makeTempDir();
    git(remoteDir, "init --bare");

    const dir = makeTempDir();
    git(dir, `clone ${remoteDir} .`);
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');

    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
    writeFileSync(join(dir, "index.md"), "# Index\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    git(dir, "add .");
    git(dir, 'commit -m "init vault"');
    git(dir, "branch -M main");
    git(dir, "push -u origin main");
    expect(execSync("git status --porcelain", { cwd: dir }).toString()).toBe("");

    const archiveDir = join(dir, "_archive", "raw-dedup-2026-05-28", "articles");
    mkdirSync(archiveDir, { recursive: true });
    const longName = "w".repeat(200) + ".md";
    const relPath = `_archive/raw-dedup-2026-05-28/articles/${longName}`;
    writeFileSync(join(dir, relPath), "---\ntitle: archived\n---\n\nbody\n");

    const { exitCode, result } = await runSyncPush({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.pushed).toBe(true);
      expect(result.data.path_fixes).toBe(1);
      expect(result.data.commit_message).toContain("fixed 1 long path");
    }

    expect(existsSync(join(dir, relPath))).toBe(false);
    const renamed = readdirSync(archiveDir).filter(name => name.endsWith(".md"));
    expect(renamed).toHaveLength(1);
    expect(`_archive/raw-dedup-2026-05-28/articles/${renamed[0]!}`.length).toBeLessThanOrEqual(240);
    expect(execSync("git status --porcelain", { cwd: dir }).toString()).toBe("");
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
    // Point bare remote HEAD to main so subsequent clones inherit it
    git(remoteDir, "symbolic-ref HEAD refs/heads/main");
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

describe("runSyncLock", () => {
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

  it("acquires lock on fresh vault and writes lockfile", () => {
    const dir = makeTempDir();
    const { exitCode, result } = runSyncLock({ vault: dir, summary: "test lock" });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acquired).toBe(true);
      expect(result.data.lock.summary).toBe("test lock");
      expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(true);
    }
  });

  it("refuses second acquire with SYNC_LOCK_HELD", () => {
    const dir = makeTempDir();
    // First acquire
    const { exitCode: exitCode1 } = runSyncLock({ vault: dir, summary: "test lock" });
    expect(exitCode1).toBe(ExitCode.OK);
    // Second acquire should fail
    const { exitCode: exitCode2, result: result2 } = runSyncLock({ vault: dir, summary: "another lock" });
    expect(exitCode2).toBe(ExitCode.SYNC_LOCK_HELD); // 48
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.data.acquired).toBe(false);
      expect(result2.data.held_by).toBeDefined();
    }
  });

  it("--force always wins and overwrites lock", () => {
    const dir = makeTempDir();
    // First acquire
    const { result: result1 } = runSyncLock({ vault: dir, summary: "first" });
    const lock1 = result1.ok ? result1.data.lock : null;
    expect(lock1).toBeDefined();
    // Force overwrite
    const { exitCode: exitCode2, result: result2 } = runSyncLock({
      vault: dir,
      summary: "second",
      force: true,
    });
    expect(exitCode2).toBe(ExitCode.OK);
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.data.acquired).toBe(true);
      expect(result2.data.lock.summary).toBe("second");
    }
  });

  it("auto-takeover when lock is stale", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    // Write a stale lock (expired 1 minute ago)
    const now = new Date();
    const expiredLock = {
      session_id: "old-session",
      pid: 9999,
      cwd: "/old/path",
      summary: "old lock",
      acquired: new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
      expires: new Date(now.getTime() - 1 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(dir, ".skillwiki", "sync.lock"), JSON.stringify(expiredLock, null, 2));
    // Now try to acquire
    const { exitCode, result } = runSyncLock({ vault: dir, summary: "new lock" });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.acquired).toBe(true);
      expect(result.data.lock.summary).toBe("new lock");
    }
  });

  it("respects custom ttl-minutes", () => {
    const dir = makeTempDir();
    const now = new Date();
    const { result } = runSyncLock({ vault: dir, summary: "test", ttlMinutes: 60 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expiresTime = new Date(result.data.lock.expires).getTime();
      const nowTime = now.getTime();
      // Lock should expire around 60 minutes from now (+/- 5 seconds)
      expect(expiresTime - nowTime).toBeGreaterThan(59 * 60 * 1000 - 5000);
      expect(expiresTime - nowTime).toBeLessThan(61 * 60 * 1000 + 5000);
    }
  });
});

describe("runSyncUnlock", () => {
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

  it("removes lock when held by this session", () => {
    const dir = makeTempDir();
    // Acquire a lock
    const { result: result1 } = runSyncLock({ vault: dir });
    expect(result1.ok).toBe(true);
    // Verify file exists
    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(true);
    // Unlock
    const { exitCode, result } = runSyncUnlock({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released).toBe(true);
    }
    // Verify file is gone
    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(false);
  });

  it("is no-op when lock not held or missing", () => {
    const dir = makeTempDir();
    // Unlock on empty vault
    const { exitCode, result } = runSyncUnlock({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released).toBe(false);
    }
  });

  it("does not delete lock held by another session", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    // Write a lock from a different session
    const lock = {
      session_id: "other-session",
      pid: 9999,
      cwd: "/other/path",
      summary: "other lock",
      acquired: new Date().toISOString(),
      expires: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(dir, ".skillwiki", "sync.lock"), JSON.stringify(lock, null, 2));
    // Try to unlock (should be no-op)
    const { result } = runSyncUnlock({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released).toBe(false);
    }
    // Verify file still exists
    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(true);
  });

  it("force unlock with no peer is no-op", () => {
    const dir = makeTempDir();
    const { exitCode, result } = runSyncUnlock({ vault: dir, force: true });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released).toBe(false);
      expect(result.data.prior).toBeUndefined();
    }
  });

  it("force unlock releases peer-held lock and surfaces prior holder", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    const peerLock = {
      session_id: "stale-peer",
      pid: 47225,
      cwd: "/other/path",
      summary: "stale lock from yesterday",
      acquired: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expires: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(dir, ".skillwiki", "sync.lock"), JSON.stringify(peerLock, null, 2));
    const { exitCode, result } = runSyncUnlock({ vault: dir, force: true });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.released).toBe(true);
      expect(result.data.prior).toBeDefined();
      expect(result.data.prior?.session_id).toBe("stale-peer");
      expect(result.data.prior?.pid).toBe(47225);
      expect(result.data.humanHint).toContain("force-released");
      expect(result.data.humanHint).toContain("stale-peer");
    }
    // Lockfile is gone
    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(false);
  });

  it("CLI unlock releases a lock acquired by a previous CLI process without force", () => {
    const dir = makeTempDir();

    runSkillwikiCli(["sync", "lock", dir, "--summary", "cross-process-test", "--ttl-minutes", "30"]);
    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(true);

    const peers = JSON.parse(runSkillwikiCli(["sync", "peers", dir]));
    expect(peers.data.locks[0].is_self).toBe(true);

    runSkillwikiCli(["sync", "unlock", dir]);

    expect(existsSync(join(dir, ".skillwiki", "sync.lock"))).toBe(false);
  });
});

describe("runSyncPeers", () => {
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

  it("returns empty locks and stashes when vault is clean", () => {
    const dir = makeTempDir();
    const { exitCode, result } = runSyncPeers({ vault: dir });
    expect(exitCode).toBe(ExitCode.OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.locks).toEqual([]);
      expect(result.data.stashes).toEqual([]);
    }
  });

  it("lists our own lock with is_self: true", () => {
    const dir = makeTempDir();
    // Acquire a lock
    runSyncLock({ vault: dir });
    // Query peers
    const { result } = runSyncPeers({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.locks.length).toBe(1);
      expect(result.data.locks[0]!.is_self).toBe(true);
    }
  });

  it("parses wiki-sync named stashes correctly", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, "commit -m init");
    // Modify an existing tracked file so stash can capture it
    writeFileSync(join(dir, "README.md"), "modified");
    // Create a stash with wiki-sync name format
    // Git will add "On main: " prefix, but the message itself should be preserved
    const stashMsg = "wiki-sync:session123:abc12345:2026-05-23T03:25:00Z:pre-pull";
    git(dir, `stash push -m "${stashMsg}"`);
    // Query peers
    const { result } = runSyncPeers({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stashes.length).toBe(1);
      const stash = result.data.stashes[0]!;
      expect(stash.session_id).toBe("session123");
      expect(stash.cwd_hash).toBe("abc12345");
      expect(stash.timestamp).toBe("2026-05-23T03:25:00Z");
      expect(stash.summary).toBe("pre-pull");
    }
  });

  it("ignores non-wiki-sync stashes", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, "commit -m init");
    // Modify a tracked file to create a stash
    writeFileSync(join(dir, "README.md"), "modified");
    git(dir, 'stash push -m "some random stash"');
    // Query peers
    const { result } = runSyncPeers({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stashes.length).toBe(0);
    }
  });
});

describe("runSyncStatus with includeStashes", () => {
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

  it("includes stashes when --include-stashes is true", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, "commit -m init");
    // Modify a tracked file and stash it
    writeFileSync(join(dir, "README.md"), "modified");
    git(dir, 'stash push -m "test stash"');
    // Query status without stashes
    const { result: result1 } = runSyncStatus({ vault: dir, includeStashes: false });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.data.stashes).toBeUndefined();
    }
    // Query status with stashes
    const { result: result2 } = runSyncStatus({ vault: dir, includeStashes: true });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.data.stashes).toBeDefined();
      expect(result2.data.stashes!.length).toBe(1);
      // The message will have "On main: " prefix from git
      expect(result2.data.stashes![0]!.message).toContain("test stash");
    }
  });

  it("defaults to not including stashes when option omitted", () => {
    const dir = makeTempDir();
    git(dir, "init");
    git(dir, 'config user.email "t@t"');
    git(dir, 'config user.name "t"');
    writeFileSync(join(dir, "README.md"), "hello");
    git(dir, "add .");
    git(dir, "commit -m init");
    // Modify and stash
    writeFileSync(join(dir, "README.md"), "modified");
    git(dir, 'stash push -m "test stash"');
    // Query status without option (default)
    const { result } = runSyncStatus({ vault: dir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stashes).toBeUndefined();
    }
  });
});
