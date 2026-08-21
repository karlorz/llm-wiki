import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { runDoctor } from "../../src/commands/doctor.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "..", "..", "..");
const FIXTURE = join(
  REPO_ROOT,
  "vault-sync",
  "test",
  "fixtures",
  "snapshot-health",
  "02-enabled-timer-successful-service-fresh-no-change.json",
);

function git(cwd: string, args: string[]): string {
  return execSync(`git -C "${cwd}" ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function makeGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "user.email", "test@test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "init"]);
}

function writeReviewRequiredJournal(repo: string, opId: string): void {
  const gitDir = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const opsDir = join(gitDir, "vault-sync", "operations");
  mkdirSync(opsDir, { recursive: true });
  const head = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(opsDir, `${opId}.env`), [
    `operation_id=${opId}`,
    "phase=review-required",
    "handoff=1",
    `target_oid=${head}`,
    `worktree_path=${repo}`,
    `worktree_git_dir=${gitDir}`,
    "",
  ].join("\n"));
}

function makeUnmergedLog(repo: string): void {
  writeFileSync(join(repo, "log.md"), "base\n");
  git(repo, ["add", "log.md"]);
  git(repo, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-m", "log base"]);
  git(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "log.md"), "side\n");
  git(repo, ["add", "log.md"]);
  git(repo, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-m", "log side"]);
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "log.md"), "main\n");
  git(repo, ["add", "log.md"]);
  git(repo, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-m", "log main"]);
  try {
    execSync(`git -C "${repo}" merge side`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // expected conflict
  }
}

function setupSnapshotter(opts: {
  configureWorktree: boolean;
  withJournal?: boolean;
  withUnmerged?: boolean;
}): { home: string; live: string; worktree: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "snap-wt-health-"));
  const home = join(root, "home");
  const live = join(root, "wiki");
  const worktree = join(root, "wiki-git");
  mkdirSync(join(home, ".skillwiki"), { recursive: true });
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "SCHEMA.md"), "# schema\n");
  makeGitRepo(worktree);
  if (opts.withJournal) writeReviewRequiredJournal(worktree, "op-stall-001");
  if (opts.withUnmerged) makeUnmergedLog(worktree);

  const envLines = [
    `WIKI_PATH=${live}`,
    "vault_sync.installed=true",
    "vault_sync.role=snapshotter",
    "vault_sync.service_scope=user",
  ];
  if (opts.configureWorktree) envLines.push(`vault_sync.snapshot_worktree=${worktree}`);
  writeFileSync(join(home, ".skillwiki", ".env"), envLines.join("\n") + "\n");

  const shareDir = process.platform === "darwin"
    ? join(home, "Library", "Application Support", "vault-sync", "bin")
    : join(home, ".local", "share", "vault-sync", "bin");
  mkdirSync(shareDir, { recursive: true });
  writeFileSync(join(shareDir, "wiki-snapshot.sh"), "#!/usr/bin/env bash\n# --max-delete 10\n");

  return {
    home,
    live,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function doctor(home: string) {
  return runDoctor({
    home,
    envValue: undefined,
    argv: ["node", "skillwiki", "doctor"],
    currentVersion: "0.10.60",
    env: { VS_SNAPSHOT_HEALTH_FIXTURE: FIXTURE } as NodeJS.ProcessEnv,
  });
}

describe("doctor snapshot worktree journals + unmerged", () => {
  it("inspects review-required journals on the configured snapshot worktree when live vault has no .git", async () => {
    const f = setupSnapshotter({ configureWorktree: true, withJournal: true });
    const r = await doctor(f.home);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    const journals = r.result.data.checks.find(c => c.id === "vault_sync_review_required_journals");
    expect(journals?.status).toBe("warn");
    expect(journals?.detail).toContain("op-stall-001");
    expect(journals?.detail).toContain(f.worktree);
    expect(journals?.detail).not.toMatch(/No git vault — check skipped/);
    f.cleanup();
  });

  it("warns when a snapshotter has no configured snapshot worktree and live vault has no .git", async () => {
    const f = setupSnapshotter({ configureWorktree: false });
    const r = await doctor(f.home);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    const journals = r.result.data.checks.find(c => c.id === "vault_sync_review_required_journals");
    expect(journals?.status).toBe("warn");
    expect(journals?.detail.toLowerCase()).toContain("no configured snapshot worktree");
    const unmerged = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_worktree_unmerged");
    expect(unmerged?.status).toBe("warn");
    f.cleanup();
  });

  it("errors when the snapshot worktree has unmerged paths", async () => {
    const f = setupSnapshotter({ configureWorktree: true, withUnmerged: true });
    const r = await doctor(f.home);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    const unmerged = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_worktree_unmerged");
    expect(unmerged?.status).toBe("error");
    expect(unmerged?.detail).toContain("log.md");
    expect(unmerged?.detail).toContain(f.worktree);
    f.cleanup();
  });

  it("passes unmerged check when the snapshot worktree is clean", async () => {
    const f = setupSnapshotter({ configureWorktree: true });
    const r = await doctor(f.home);
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    const unmerged = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_worktree_unmerged");
    expect(unmerged?.status).toBe("pass");
    expect(unmerged?.detail).toContain(f.worktree);
    f.cleanup();
  });

  it("skips the unmerged check on non-snapshotter hosts", async () => {
    const root = mkdtempSync(join(tmpdir(), "leaf-wt-health-"));
    const home = join(root, "home");
    const vault = join(root, "wiki");
    mkdirSync(join(home, ".skillwiki"), { recursive: true });
    makeGitRepo(vault);
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${vault}\nvault_sync.installed=true\nvault_sync.role=leaf\n`);
    const r = await runDoctor({
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.60",
    });
    expect(r.result.ok).toBe(true);
    if (!r.result.ok) return;
    const unmerged = r.result.data.checks.find(c => c.id === "vault_sync_snapshot_worktree_unmerged");
    expect(unmerged?.status).toBe("pass");
    expect(unmerged?.detail.toLowerCase()).toMatch(/not a snapshotter|skipped/);
    rmSync(root, { recursive: true, force: true });
  });
});
