import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  runSnapshotMaintenanceDryRun,
  runSnapshotMaintenanceExecute,
  MAINTENANCE_SCHEMA_VERSION,
  type SnapshotMaintenanceInput,
  type MaintenanceAuditEvent,
} from "../../src/commands/snapshot-maintenance.js";
import type { FleetManifestAndHost } from "../../src/commands/fleet.js";

// Build an isolated protected-snapshotter fixture: fleet manifest, configured
// snapshot worktree (real git repo), review-required journals, and isolated
// flock path. Nothing here touches real /root/wiki-git.

function git(cwd: string, ...args: string[]): string {
  return execSync(`git -C "${cwd}" ${args.join(" ")}`, {
    encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function makeGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@test");
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
}

/** Write a review-required journal with the given target_oid. */
function writeReviewRequiredJournal(repo: string, opId: string, targetOid: string, reason = "stale-handoff"): void {
  const gitDir = git(repo, "rev-parse", "--git-dir");
  const absGitDir = gitDir.startsWith("/") ? gitDir : join(repo, gitDir);
  const opsDir = join(absGitDir, "vault-sync", "operations");
  mkdirSync(opsDir, { recursive: true });
  const worktreeGitDir = git(repo, "rev-parse", "--absolute-git-dir");
  const lines = [
    `operation_id=${opId}`,
    `phase=review-required`,
    `retry_count=0`,
    `original_branch=main`,
    `original_head=${targetOid}`,
    `target_oid=${targetOid}`,
    `owned_stash_oid=`,
    `preservation_scope=none`,
    `lock_identity=`,
    `helper_version=`,
    `deployed_runtime_hash=`,
    `conflict_identity=`,
    `handoff=1`,
    `reason=${reason}`,
    `worktree_path=${repo}`,
    `worktree_git_dir=${worktreeGitDir}`,
  ];
  writeFileSync(join(opsDir, `${opId}.env`), lines.join("\n") + "\n");
}

function makeFleetLoad(hostId: string, role: string, protectedFlag: boolean): FleetManifestAndHost {
  return {
    manifest: {
      hosts: {
        [hostId]: { role, protected: protectedFlag },
      },
    },
    hostId,
    source: "test",
    warnings: [],
    identityStatus: "known",
  };
}

function makeFixture(opts: {
  role?: string;
  protected?: boolean;
  hostId?: string;
  clean?: boolean;
  withJournal?: boolean;
  journalTargetAncestor?: boolean;
}): {
  home: string;
  worktree: string;
  liveVault: string;
  lockPath: string;
  fleetLoad: FleetManifestAndHost;
  targetOid: string;
} {
  const root = mkdtempSync(join(tmpdir(), "snap-maint-"));
  const home = join(root, "home");
  const worktree = join(root, "wiki-git");
  const liveVault = join(root, "wiki");
  const lockPath = join(root, "wiki-snapshot.lock");
  mkdirSync(join(home, ".skillwiki"), { recursive: true });

  makeGitRepo(worktree);
  makeGitRepo(liveVault);

  // Configure the snapshot worktree in ~/.skillwiki/.env
  writeFileSync(join(home, ".skillwiki", ".env"),
    `vault_sync.snapshot_worktree=${worktree}\nWIKI_PATH=${liveVault}\n`);

  // Make a target commit that is an ancestor of HEAD (for eligible journals).
  const targetOid = git(worktree, "rev-parse", "HEAD");

  if (opts.withJournal) {
    const target = opts.journalTargetAncestor === false ? "0".repeat(40) : targetOid;
    writeReviewRequiredJournal(worktree, "op-001", target);
  }

  // If dirty requested, add an uncommitted file.
  if (opts.clean === false) {
    writeFileSync(join(worktree, "dirty.txt"), "dirty\n");
  }

  const fleetLoad = makeFleetLoad(
    opts.hostId ?? "sg01",
    opts.role ?? "snapshotter",
    opts.protected ?? true,
  );

  return { home, worktree, liveVault, lockPath, fleetLoad, targetOid };
}

/** Write a minimal protected-snapshotter fleet.yaml under the live vault. */
function writeFleetYaml(liveVault: string): void {
  const fleetDir = join(liveVault, "projects", "llm-wiki", "architecture");
  mkdirSync(fleetDir, { recursive: true });
  writeFileSync(join(fleetDir, "fleet.yaml"), [
    "schema_version: 1",
    "vault_remote: git@example.com:org/wiki.git",
    "hosts:",
    "  sg01:",
    "    class: prod-linux",
    "    role: snapshotter",
    "    writes_to: [github]",
    "    protected: true",
    "    identity:",
    "      hostnames: [sg01]",
    "",
  ].join("\n"));
}

describe("snapshot-maintenance journal clear-stale", () => {
  describe("dry-run negative cases (fail closed)", () => {
    it("refuses unknown fleet identity", async () => {
      const f = makeFixture({});
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree,
        dryRun: true,
        reason: "test",
        fleetLoad: { ...f.fleetLoad, hostId: undefined, identityStatus: "unknown" },
        home: f.home,
        liveVaultPath: f.liveVault,
        isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) {
        expect(r.result.error).toBe("MAINTENANCE_UNKNOWN_IDENTITY");
      }
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses leaf host", async () => {
      const f = makeFixture({ role: "leaf" });
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_NOT_PROTECTED_SNAPSHOTTER");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses unprotected snapshotter", async () => {
      const f = makeFixture({ protected: false });
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_NOT_PROTECTED_SNAPSHOTTER");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses wrong worktree path", async () => {
      const f = makeFixture({});
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: "/tmp/wrong-worktree", dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_WRONG_WORKTREE");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses live vault as target", async () => {
      const f = makeFixture({});
      // Point snapshotWorktree at the live vault, but keep the configured
      // worktree as the real worktree so requested != configured is NOT the
      // failure; we need requested == liveVault == configured to hit the
      // live-vault refusal. Override the .env so configured == liveVault.
      writeFileSync(join(f.home, ".skillwiki", ".env"),
        `vault_sync.snapshot_worktree=${f.liveVault}\nWIKI_PATH=${f.liveVault}\n`);
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.liveVault, dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_LIVE_VAULT_TARGET");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses missing git repo", async () => {
      const f = makeFixture({});
      const notGit = mkdtempSync(join(tmpdir(), "notgit-"));
      writeFileSync(join(f.home, ".skillwiki", ".env"),
        `vault_sync.snapshot_worktree=${notGit}\nWIKI_PATH=${f.liveVault}\n`);
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: notGit, dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_MISSING_GIT_REPO");
      rmSync(f.home, { recursive: true, force: true });
      rmSync(notGit, { recursive: true, force: true });
    });

    it("refuses journal with non-ancestor target", async () => {
      const f = makeFixture({ withJournal: true, journalTargetAncestor: false });
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "test",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.plan!.eligible_journals).toHaveLength(0);
        expect(r.result.data.plan!.skipped_journals[0]!.refusal_reason).toBe("not-ancestor");
        expect(r.result.data.plan!.approval_id).toBeNull();
      }
      rmSync(f.home, { recursive: true, force: true });
    });
  });

  describe("dry-run positive case", () => {
    it("emits a deterministic approval ID for an eligible journal", async () => {
      const f = makeFixture({ withJournal: true, journalTargetAncestor: true });
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery 2026-07-25",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        const plan = r.result.data.plan!;
        expect(plan.eligible_journals).toHaveLength(1);
        expect(plan.eligible_journals[0]!.operation_id).toBe("op-001");
        expect(plan.approval_id).toMatch(/^smap1-[0-9a-f]{32}$/);
        expect(plan.host_id).toBe("sg01");
        expect(plan.protected).toBe(true);
        expect(plan.snapshot_worktree).toBe(f.worktree);
      }
      rmSync(f.home, { recursive: true, force: true });
    });

    it("approval ID is deterministic (same state -> same ID)", async () => {
      const f = makeFixture({ withJournal: true });
      const r1 = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      const r2 = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
      });
      expect(r1.result.ok && r2.result.ok).toBe(true);
      if (r1.result.ok && r2.result.ok) {
        expect(r1.result.data.plan!.approval_id).toBe(r2.result.data.plan!.approval_id);
      }
      rmSync(f.home, { recursive: true, force: true });
    });

    it("resolves fleet identity from live vault path without injected fleetLoad (v0.10.16)", async () => {
      // Regression: vault:"" suppressed WIKI_PATH and always yielded UNKNOWN_IDENTITY.
      const f = makeFixture({ withJournal: true, journalTargetAncestor: true });
      writeFleetYaml(f.liveVault);
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree,
        dryRun: true,
        reason: "fleet from live vault",
        // intentionally omit fleetLoad — must load from liveVaultPath/WIKI_PATH
        home: f.home,
        liveVaultPath: f.liveVault,
        isTty: true,
        env: {
          ...process.env,
          HOME: f.home,
          WIKI_PATH: f.liveVault,
          SKILLWIKI_HOST_ID: "sg01",
        } as NodeJS.ProcessEnv,
      });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.plan!.host_id).toBe("sg01");
        expect(r.result.data.plan!.approval_id).toMatch(/^smap1-[0-9a-f]{32}$/);
      }
      rmSync(f.home, { recursive: true, force: true });
    });

    it("empty-vault-fleet-load: omits liveVaultPath so fleet resolves from WIKI_PATH (H4 invariant)", async () => {
      // H4: never pass vault:"" - empty string suppresses WIKI_PATH and yields
      // UNKNOWN_IDENTITY. When liveVaultPath is unset, the dry-run must resolve
      // the live vault from WIKI_PATH/home-dotenv before loading fleet.yaml.
      const f = makeFixture({ withJournal: true, journalTargetAncestor: true });
      writeFleetYaml(f.liveVault);
      const r = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree,
        dryRun: true,
        reason: "fleet from WIKI_PATH",
        // intentionally omit both fleetLoad AND liveVaultPath - must resolve
        // the live vault from WIKI_PATH before fleet load (H4 invariant).
        home: f.home,
        isTty: true,
        env: {
          ...process.env,
          HOME: f.home,
          WIKI_PATH: f.liveVault,
          SKILLWIKI_HOST_ID: "sg01",
        } as NodeJS.ProcessEnv,
      });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.plan!.host_id).toBe("sg01");
      }
      rmSync(f.home, { recursive: true, force: true });
    });
  });

  describe("execution negative cases", () => {
    it("refuses missing TTY", async () => {
      const f = makeFixture({ withJournal: true });
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId: "smap1-fake", fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: false, skipFlock: true,
        snapshotLockPath: f.lockPath,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_NO_TTY");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses missing reason", async () => {
      const f = makeFixture({ withJournal: true });
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "",
        approvalId: "smap1-fake", fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_NO_REASON");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses missing approval ID", async () => {
      const f = makeFixture({ withJournal: true });
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId: undefined, fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_NO_APPROVAL_ID");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses stale/malformed approval ID", async () => {
      const f = makeFixture({ withJournal: true });
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId: "smap1-stalefake", fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_STALE_APPROVAL_ID");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("refuses dirty worktree", async () => {
      const f = makeFixture({ withJournal: true, clean: false });
      // Get the real approval ID first via dry run (which doesn't require clean).
      // Pass the same snapshotLockPath so the approval digest matches execution.
      const dry = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
        snapshotLockPath: f.lockPath,
      });
      const approvalId = dry.result.ok ? dry.result.data.plan!.approval_id! : "";
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId, fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath,
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_DIRTY_WORKTREE");
      rmSync(f.home, { recursive: true, force: true });
    });
  });

  describe("execution positive case", () => {
    it("supersedes exactly the approved eligible journal", async () => {
      const f = makeFixture({ withJournal: true });
      const dry = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery 2026-07-25",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
        snapshotLockPath: f.lockPath,
      });
      expect(dry.result.ok).toBe(true);
      const approvalId = dry.result.ok ? dry.result.data.plan!.approval_id! : "";

      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery 2026-07-25",
        approvalId, fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath, sessionId: "sess-001",
      });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.execution!.superseded).toEqual(["op-001"]);
        expect(r.result.data.execution!.no_op).toBe(false);
      }
      // Verify the journal is now complete.
      const gitDir = git(f.worktree, "rev-parse", "--git-dir");
      const absGitDir = gitDir.startsWith("/") ? gitDir : join(f.worktree, gitDir);
      const journalPath = join(absGitDir, "vault-sync", "operations", "op-001.env");
      const content = readFileSync(journalPath, "utf8");
      expect(content).toContain("phase=complete");
      expect(content).toContain("superseded_at=");
      expect(content).toContain("cleared_by=snapshot-maintenance:");
      rmSync(f.home, { recursive: true, force: true });
    });

    it("approval reuse cannot authorize newly eligible journals", async () => {
      const f = makeFixture({ withJournal: true });
      const dry = await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault, isTty: true,
        snapshotLockPath: f.lockPath,
      });
      const approvalId = dry.result.ok ? dry.result.data.plan!.approval_id! : "";

      // Execute once - supersedes op-001.
      await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId, fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath, sessionId: "sess-001",
      });

      // Add a NEW eligible journal.
      const targetOid = git(f.worktree, "rev-parse", "HEAD");
      writeReviewRequiredJournal(f.worktree, "op-002", targetOid);

      // Reuse the old approval ID - the recomputed plan will have a different
      // approval_id (different eligible set), so the old ID must be rejected.
      const r = await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "recovery",
        approvalId, fleetLoad: f.fleetLoad, home: f.home,
        liveVaultPath: f.liveVault, isTty: true, skipFlock: true,
        snapshotLockPath: f.lockPath, sessionId: "sess-002",
      });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) expect(r.result.error).toBe("MAINTENANCE_STALE_APPROVAL_ID");
      rmSync(f.home, { recursive: true, force: true });
    });
  });

  describe("audit", () => {
    it("records dry-run, success, and refusal events without secrets", async () => {
      const events: MaintenanceAuditEvent[] = [];
      const audit = (e: MaintenanceAuditEvent) => events.push(e);
      const f = makeFixture({ withJournal: true });

      // refusal (no reason in execution)
      await runSnapshotMaintenanceExecute({
        snapshotWorktree: f.worktree, dryRun: false, reason: "",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault,
        isTty: true, skipFlock: true, snapshotLockPath: f.lockPath, auditSink: audit,
      });
      // dry-run
      await runSnapshotMaintenanceDryRun({
        snapshotWorktree: f.worktree, dryRun: true, reason: "recovery",
        fleetLoad: f.fleetLoad, home: f.home, liveVaultPath: f.liveVault,
        isTty: true, auditSink: audit,
      });

      expect(events.length).toBeGreaterThanOrEqual(2);
      const refusals = events.filter(e => e.result === "refusal");
      const dryRuns = events.filter(e => e.result === "dry-run");
      expect(refusals.length).toBeGreaterThanOrEqual(1);
      expect(dryRuns.length).toBeGreaterThanOrEqual(1);
      for (const e of events) {
        expect(e.schema_version).toBe(MAINTENANCE_SCHEMA_VERSION);
        expect(e.command).toBe("snapshot-maintenance journal clear-stale");
        expect(e.canonical_target).toBe(f.worktree);
        // No secret-like fields.
        expect(JSON.stringify(e)).not.toMatch(/password|secret|api[_-]?key|token|bearer/i);
      }
      rmSync(f.home, { recursive: true, force: true });
    });
  });
});
