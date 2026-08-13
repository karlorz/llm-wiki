import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ExitCode, err, ok } from "@skillwiki/shared";
import {
  type ManagedWriteMode,
  type ManagedWriteReceipt,
  runManagedWritePreflight,
  runManagedWriteTransaction,
} from "../../src/utils/managed-write-preflight.js";
import type { SyncPeersOutput } from "../../src/commands/sync.js";
import { managedWriteLockPath } from "../../src/utils/managed-write-lock.js";

const SG01_FLEET = `schema_version: 1
vault_remote: owner/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [test-host]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`;

function writeFleet(vault: string, body: string = SG01_FLEET): void {
  mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
  writeFileSync(join(vault, "projects", "llm-wiki", "architecture", "fleet.yaml"), body);
}

function makeGitConvergenceVault(label: string): { vault: string; head: string } {
  const vault = mkdtempSync(join(tmpdir(), `${label}-`));
  git(vault, ["init"]);
  git(vault, ["config", "user.email", "t@t"]);
  git(vault, ["config", "user.name", "t"]);
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFleet(vault);
  git(vault, ["add", "."]);
  git(vault, ["commit", "-m", "init"]);
  return { vault, head: git(vault, ["rev-parse", "HEAD"]) };
}

function makeNonGitMutationVault(label: string, fleetBody: string = SG01_FLEET): string {
  const vault = mkdtempSync(join(tmpdir(), `${label}-`));
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFleet(vault, fleetBody);
  return vault;
}

function writeManagedLockRecord(vault: string, record: Record<string, unknown>): string {
  const lockPath = managedWriteLockPath(vault);
  mkdirSync(join(lockPath, ".."), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(record)}\n`);
  return lockPath;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function nonblockingPeerCheck() {
  return {
    exitCode: ExitCode.OK,
    result: ok(makePeerOutput()),
  };
}

function makePeerOutput(overrides: Partial<SyncPeersOutput> = {}): SyncPeersOutput {
  return {
    locks: [],
    stashes: [],
    stash_audit: [],
    managed_writers: { count: 0, kinds: [], blocking: false },
    blocking: false,
    humanHint: "no peers detected",
    ...overrides,
  };
}

function makeReceipt(vault: string, mode: ManagedWriteMode): ManagedWriteReceipt {
  const gitWriter = mode === "git-writer";
  return {
    mode,
    mutation_vault: resolve(vault),
    git_vault: gitWriter ? resolve(vault) : null,
    base_oid: gitWriter ? "base-oid" : null,
    converged: gitWriter,
    convergence_source: "single-path",
  };
}

function writeReviewJournal(
  vault: string,
  input: { opId: string; originalHead: string; targetOid: string; reason: string },
): string {
  const gitDir = git(vault, ["rev-parse", "--absolute-git-dir"]);
  const opDir = join(gitDir, "vault-sync", "operations");
  const path = join(opDir, `${input.opId}.env`);
  mkdirSync(opDir, { recursive: true });
  writeFileSync(
    path,
    [
      `operation_id=${input.opId}`,
      "phase=review-required",
      "handoff=1",
      `original_head=${input.originalHead}`,
      `target_oid=${input.targetOid}`,
      `worktree_git_dir=${gitDir}`,
      `reason=${input.reason}`,
    ].join("\n") + "\n",
  );
  return path;
}

function makeUnmergedFleetVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "managed-preflight-unmerged-"));
  git(vault, ["init"]);
  git(vault, ["branch", "-M", "main"]);
  git(vault, ["config", "user.email", "t@t"]);
  git(vault, ["config", "user.name", "t"]);
  mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(vault, "index.md"), "# Index\nbase\n");
  writeFileSync(
    join(vault, "projects", "llm-wiki", "architecture", "fleet.yaml"),
    `schema_version: 1
vault_remote: owner/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [test-host]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    identity:
      hostnames: [sg01]
`,
  );
  git(vault, ["add", "."]);
  git(vault, ["commit", "-m", "base"]);
  git(vault, ["checkout", "-b", "theirs"]);
  writeFileSync(join(vault, "index.md"), "# Index\ntheirs\n");
  git(vault, ["commit", "-am", "theirs"]);
  git(vault, ["checkout", "main"]);
  writeFileSync(join(vault, "index.md"), "# Index\nours\n");
  git(vault, ["commit", "-am", "ours"]);
  try {
    git(vault, ["merge", "theirs"]);
  } catch {
    /* expected conflict */
  }
  return vault;
}

describe("managed write preflight", () => {
  it("converges a known Git writer and freezes exact HEAD", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-"));
    git(vault, ["init"]);
    git(vault, ["config", "user.email", "t@t"]);
    git(vault, ["config", "user.name", "t"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "init"]);
    mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
    writeFileSync(
      join(vault, "projects", "llm-wiki", "architecture", "fleet.yaml"),
      `schema_version: 1
vault_remote: owner/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [test-host]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    protected: true
    identity:
      hostnames: [sg01]
`,
    );
    const head = git(vault, ["rev-parse", "HEAD"]);
    const converge = vi.fn(async () =>
      ok({ before_oid: head, after_oid: head, changed: false, helper_path: "/test/helper" }),
    );
    const run = await runManagedWritePreflight(
      { vault, command: "page publish", hostId: "macos-dev" },
      { converge },
    );
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({
      ok: true,
      data: { mode: "git-writer", converged: true, base_oid: head },
    });
    expect(converge).toHaveBeenCalledTimes(1);
  });

  it("returns immutable-record mode without inventing Git authority", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-s3-"));
    mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFileSync(
      join(vault, "projects", "llm-wiki", "architecture", "fleet.yaml"),
      `schema_version: 1
vault_remote: owner/wiki
hosts:
  s3-leaf:
    class: dev-linux
    role: leaf
    writes_to: [s3]
    identity:
      hostnames: [s3-leaf]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    identity:
      hostnames: [sg01]
`,
    );
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      { vault, command: "page publish", hostId: "s3-leaf" },
      { converge },
    );
    expect(run.result).toMatchObject({
      ok: true,
      data: { mode: "immutable-record", base_oid: null, converged: false },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("fails closed when the mutation vault fleet.yaml cannot be loaded", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-fleet-unreadable-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFleet(vault, "schema_version: [unclosed");
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      { vault, command: "page publish", hostId: "macos-dev" },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: { reason: "fleet-unreadable" },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("treats a truly absent fleet as standalone", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-no-fleet-"));
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      { vault, command: "page publish", hostId: "macos-dev" },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.OK);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        mode: "standalone",
        mutation_vault: resolve(vault),
        git_vault: null,
        base_oid: null,
        converged: false,
        convergence_source: "single-path",
      },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("keeps a distinct explicit convergence vault in a standalone receipt", async () => {
    const mutationVault = mkdtempSync(join(tmpdir(), "managed-preflight-standalone-explicit-"));
    writeFileSync(join(mutationVault, "SCHEMA.md"), "# Schema\n");
    const { vault: convergenceVault } = makeGitConvergenceVault(
      "managed-preflight-standalone-explicit-git",
    );
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "page publish",
        hostId: "macos-dev",
      },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.OK);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        mode: "standalone",
        mutation_vault: resolve(mutationVault),
        git_vault: null,
        base_oid: null,
        converged: false,
        convergence_vault: resolve(convergenceVault),
        convergence_source: "explicit",
      },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("refuses unmerged state before convergence", async () => {
    const unmergedVault = makeUnmergedFleetVault();
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      { vault: unmergedVault, command: "page publish", hostId: "macos-dev" },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: { reason: "unmerged-paths" },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("supersedes stale review-required journals when worktree is clean", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-rr-"));
    git(vault, ["init"]);
    git(vault, ["branch", "-M", "main"]);
    git(vault, ["config", "user.email", "t@t"]);
    git(vault, ["config", "user.name", "t"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
    writeFileSync(
      join(vault, "projects", "llm-wiki", "architecture", "fleet.yaml"),
      `schema_version: 1
vault_remote: owner/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [test-host]
  sg01:
    class: prod-linux
    role: snapshotter
    writes_to: [github]
    identity:
      hostnames: [sg01]
`,
    );
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "base"]);
    const base = git(vault, ["rev-parse", "HEAD"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\nv2\n");
    git(vault, ["commit", "-am", "advance"]);
    const head = git(vault, ["rev-parse", "HEAD"]);
    const opId = "pull-test-stale-rr";
    const journalPath = writeReviewJournal(vault, {
      opId,
      originalHead: base,
      targetOid: base,
      reason: "stash-failed",
    });
    const converge = vi.fn(async () =>
      ok({ before_oid: head, after_oid: head, changed: false, helper_path: "/test/helper" }),
    );
    const run = await runManagedWritePreflight(
      { vault, command: "page publish", hostId: "macos-dev" },
      { converge },
    );
    expect(run.exitCode).toBe(0);
    expect(run.result.ok).toBe(true);
    expect(converge).toHaveBeenCalledTimes(1);
    const journal = readFileSync(journalPath, "utf8");
    expect(journal).toMatch(/phase=complete/);
    expect(journal).toMatch(/superseded-stale-review-required/);
  });

  it("supersedes a resolved dirty handoff and reclaims its dead lock in one transaction", async () => {
    const { vault, head: base } = makeGitConvergenceVault("managed-preflight-dirty-rr");
    git(vault, ["branch", "-M", "main"]);
    const opId = "pull-test-dirty-rr";
    const journalPath = writeReviewJournal(vault, {
      opId,
      originalHead: base,
      targetOid: base,
      reason: "stash-failed",
    });
    // dirty worktree
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\ndirty\n");
    const lockPath = managedWriteLockPath(vault);
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 999999999,
        owner_token: "dead-pull-owner",
        acquired: "2026-07-24T03:10:03.000Z",
        command: "wiki-pull",
      })}\n`,
    );

    const converge = vi.fn(async () =>
      ok({ before_oid: base, after_oid: base, changed: false, helper_path: "/test/helper" }),
    );
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ published: true }) }));
    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "page publish",
        hostId: "macos-dev",
        allowImmutableRecord: false,
        mutate,
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({ ok: true, data: { published: true } });
    expect(converge).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);

    const journal = readFileSync(journalPath, "utf8");
    expect(journal).toMatch(/phase=complete/);
    expect(journal).toMatch(/reason=superseded-stale-review-required/);
    expect(journal).toMatch(/prior_reason=stash-failed/);
    expect(existsSync(lockPath)).toBe(false);
    const recoveryDir = join(lockPath, "..", "recovery");
    expect(
      readdirSync(recoveryDir).filter((file) => file.startsWith("stale-managed-write-lock-")),
    ).toHaveLength(1);
  });

  it("converges a non-Git mutation target through an explicit Git convergence vault", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-fuse");
    const { vault: convergenceVault, head } = makeGitConvergenceVault("managed-preflight-git");
    const converge = vi.fn(async (input: { vault: string }) => {
      expect(resolve(input.vault)).toBe(resolve(convergenceVault));
      return ok({
        before_oid: head,
        after_oid: head,
        changed: false,
        helper_path: "/test/helper",
      });
    });
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        mode: "git-writer",
        host_id: "sg01",
        convergence_vault: resolve(convergenceVault),
        converged: true,
        base_oid: head,
      },
    });
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        vault: resolve(convergenceVault),
      }),
    );
  });

  it("reclaims a dead live-vault lock using explicit Git convergence state", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-fuse-dead-lock");
    const { vault: convergenceVault, head } = makeGitConvergenceVault(
      "managed-preflight-git-dead-lock",
    );
    const lockPath = writeManagedLockRecord(mutationVault, {
      pid: 999999999,
      owner_hostname: hostname(),
      owner_token: "dead-fuse-owner",
      acquired: "2026-07-26T11:39:59.741Z",
      command: "log-append",
    });
    const converge = vi.fn(async () =>
      ok({ before_oid: head, after_oid: head, changed: false, helper_path: "/test/helper" }),
    );
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ materialized: true }) }));

    const run = await runManagedWriteTransaction(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
        allowImmutableRecord: false,
        mutate,
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );

    expect(run.exitCode).toBe(ExitCode.OK);
    expect(run.result).toMatchObject({ ok: true, data: { materialized: true } });
    expect(converge).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
    const recoveryDir = join(lockPath, "..", "recovery");
    const recoveryFiles = readdirSync(recoveryDir).filter((file) =>
      file.startsWith("stale-managed-write-lock-"),
    );
    expect(recoveryFiles).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(recoveryDir, recoveryFiles[0]), "utf8"))).toMatchObject({
      recovery_reason: "owner_pid_dead",
      owner_pid_alive: false,
      git_state_vault: resolve(convergenceVault),
      lock: { owner_token: "dead-fuse-owner", command: "log-append" },
    });
  });

  it("does not reclaim a live FUSE owner even with a clean convergence vault", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-fuse-live-lock");
    const { vault: convergenceVault } = makeGitConvergenceVault(
      "managed-preflight-git-live-lock",
    );
    const lockPath = writeManagedLockRecord(mutationVault, {
      pid: process.pid,
      owner_hostname: hostname(),
      owner_token: "live-fuse-owner",
      acquired: "2026-07-26T11:39:59.741Z",
      command: "log-append",
    });
    const converge = vi.fn();
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ materialized: true }) }));

    const run = await runManagedWriteTransaction(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
        allowImmutableRecord: false,
        mutate,
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );

    expect(run.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(run.result).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    expect(existsSync(lockPath)).toBe(true);
    expect(converge).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not reclaim a dead FUSE owner when convergence Git state is unsafe", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-fuse-unsafe-lock");
    const { vault: convergenceVault } = makeGitConvergenceVault(
      "managed-preflight-git-unsafe-lock",
    );
    const lockPath = writeManagedLockRecord(mutationVault, {
      pid: 999999999,
      owner_hostname: hostname(),
      owner_token: "dead-fuse-owner",
      acquired: "2026-07-26T11:39:59.741Z",
      command: "log-append",
    });
    const gitDir = git(convergenceVault, ["rev-parse", "--absolute-git-dir"]);
    writeFileSync(join(gitDir, "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");
    const converge = vi.fn();
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ materialized: true }) }));

    const run = await runManagedWriteTransaction(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
        allowImmutableRecord: false,
        mutate,
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );

    expect(run.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(run.result).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    expect(existsSync(lockPath)).toBe(true);
    expect(converge).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "foreign-host", ownerHostname: "another-writer.example.invalid" },
    { label: "legacy unknown-origin", ownerHostname: undefined },
  ])("does not reclaim a $label FUSE lock from a dead local PID", async ({ label, ownerHostname }) => {
    const mutationVault = makeNonGitMutationVault(`managed-preflight-fuse-${label}-lock`);
    const { vault: convergenceVault } = makeGitConvergenceVault(
      `managed-preflight-git-${label}-lock`,
    );
    const lockPath = writeManagedLockRecord(mutationVault, {
      pid: 999999999,
      owner_hostname: ownerHostname,
      owner_token: "foreign-or-legacy-fuse-owner",
      acquired: "2026-07-26T11:39:59.741Z",
      command: "log-append",
    });
    const converge = vi.fn();
    const mutate = vi.fn(async () => ({ exitCode: 0, result: ok({ materialized: true }) }));

    const run = await runManagedWriteTransaction(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
        allowImmutableRecord: false,
        mutate,
      },
      { converge, syncPeers: nonblockingPeerCheck },
    );

    expect(run.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(run.result).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    expect(existsSync(lockPath)).toBe(true);
    expect(converge).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("auto-resolves the configured snapshot worktree for a protected snapshotter write", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-auto-fuse");
    const { vault: convergenceVault, head } = makeGitConvergenceVault(
      "managed-preflight-auto-git",
    );
    const converge = vi.fn(async (input: { vault: string }) => {
      expect(resolve(input.vault)).toBe(resolve(convergenceVault));
      return ok({
        before_oid: head,
        after_oid: head,
        changed: false,
        helper_path: "/test/helper",
      });
    });

    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        command: "log-append",
        hostId: "sg01",
      },
      {
        converge,
        resolveConfiguredSnapshotWorktree: () => convergenceVault,
      },
    );

    expect(run.exitCode).toBe(ExitCode.OK);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        mode: "git-writer",
        host_id: "sg01",
        mutation_vault: resolve(mutationVault),
        convergence_vault: resolve(convergenceVault),
        git_vault: resolve(convergenceVault),
        convergence_source: "configured",
        base_oid: head,
        converged: true,
      },
    });
    expect(converge).toHaveBeenCalledTimes(1);
  });

  it("fails before mutation when a protected snapshotter has no configured convergence worktree", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-auto-missing");
    const converge = vi.fn();

    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        command: "log-append",
        hostId: "sg01",
      },
      {
        converge,
        resolveConfiguredSnapshotWorktree: () => undefined,
      },
    );

    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: {
        reason: "convergence-vault-not-configured",
        host_id: "sg01",
      },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("refuses a missing Git checkout on the convergence vault", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-no-git-mut");
    const convergenceVault = makeNonGitMutationVault("managed-preflight-no-git-conv");
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      detail: { reason: "convergence-vault-not-git" },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("allows fleet.yaml content drift when both paths resolve the same host id", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-fleet-drift-mut");
    const { vault: convergenceVault, head } = makeGitConvergenceVault(
      "managed-preflight-fleet-drift-git",
    );
    // S3-ahead fleet drift is normal before rclone; only host identity must match.
    writeFleet(
      mutationVault,
      SG01_FLEET.replace("vault_remote: owner/wiki", "vault_remote: owner/wiki-s3-ahead"),
    );
    const converge = vi.fn(async () =>
      ok({ before_oid: head, after_oid: head, changed: false, helper_path: "/test/helper" }),
    );
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge },
    );
    expect(run.exitCode).toBe(0);
    expect(run.result).toMatchObject({
      ok: true,
      data: { mode: "git-writer", host_id: "sg01", converged: true },
    });
    expect(converge).toHaveBeenCalledTimes(1);
  });

  it("refuses convergence vault that cannot resolve the same host identity", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-id-mut");
    const { vault: convergenceVault } = makeGitConvergenceVault("managed-preflight-id-git");
    // Convergence fleet has no sg01 host — explicit hostId cannot resolve there.
    writeFleet(
      convergenceVault,
      `schema_version: 1
vault_remote: owner/wiki
hosts:
  macos-dev:
    class: dev-macos
    role: leaf
    writes_to: [github]
    identity:
      hostnames: [test-host]
`,
    );
    const converge = vi.fn();
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      detail: { reason: "convergence-vault-identity-mismatch" },
    });
    expect(converge).not.toHaveBeenCalled();
  });

  it("refuses convergence helper failure before mutation", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-helper-mut");
    const { vault: convergenceVault } = makeGitConvergenceVault("managed-preflight-helper-git");
    const converge = vi.fn(async () => err("GIT_PULL_FAILED", { reason: "helper-failed" }));
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.SYNC_PULL_FAILED);
    expect(run.result.ok).toBe(false);
    expect(converge).toHaveBeenCalledTimes(1);
  });

  it("does not forward the mutation lock token into dual-path converge", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-lock-mut");
    const { vault: convergenceVault, head } = makeGitConvergenceVault(
      "managed-preflight-lock-git",
    );
    const converge = vi.fn(async (input: { vault: string; lockToken?: string }) => {
      expect(input.lockToken).toBeUndefined();
      return ok({
        before_oid: head,
        after_oid: head,
        changed: false,
        helper_path: "/test/helper",
      });
    });
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
        lockToken: "mutation-lock-token",
      },
      { converge },
    );
    expect(run.exitCode).toBe(0);
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({
        vault: resolve(convergenceVault),
        lockToken: undefined,
      }),
    );
  });

  it("still forwards the lock token for single-path git-writer converge", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-preflight-single-lock-"));
    git(vault, ["init"]);
    git(vault, ["config", "user.email", "t@t"]);
    git(vault, ["config", "user.name", "t"]);
    writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
    writeFleet(vault);
    git(vault, ["add", "."]);
    git(vault, ["commit", "-m", "init"]);
    const head = git(vault, ["rev-parse", "HEAD"]);
    const converge = vi.fn(async (input: { vault: string; lockToken?: string }) => {
      expect(input.lockToken).toBe("single-path-token");
      return ok({
        before_oid: head,
        after_oid: head,
        changed: false,
        helper_path: "/test/helper",
      });
    });
    const run = await runManagedWritePreflight(
      {
        vault,
        command: "page publish",
        hostId: "macos-dev",
        lockToken: "single-path-token",
      },
      { converge },
    );
    expect(run.exitCode).toBe(0);
    expect(converge).toHaveBeenCalledWith(
      expect.objectContaining({ lockToken: "single-path-token" }),
    );
  });

  it("refuses missing HEAD after successful convergence pull", async () => {
    const mutationVault = makeNonGitMutationVault("managed-preflight-head-mut");
    // Convergence path that is a Git dir but has no commits/HEAD after "pull".
    const convergenceVault = mkdtempSync(join(tmpdir(), "managed-preflight-head-git-"));
    git(convergenceVault, ["init"]);
    writeFileSync(join(convergenceVault, "SCHEMA.md"), "# Schema\n");
    writeFleet(convergenceVault);
    const converge = vi.fn(async () =>
      ok({ before_oid: "missing", after_oid: "missing", changed: false, helper_path: "/test/helper" }),
    );
    const run = await runManagedWritePreflight(
      {
        vault: mutationVault,
        convergenceVault,
        command: "projections materialize",
        hostId: "sg01",
      },
      { converge },
    );
    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      detail: { reason: "missing-head-after-converge" },
    });
  });

  it("runs exactly one peer check after preflight while the lock is held", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-peer-gate-order-"));
    const lockPath = managedWriteLockPath(vault);
    const events: string[] = [];
    const preflight = vi.fn(async () => {
      events.push("preflight");
      return { exitCode: ExitCode.OK, result: ok(makeReceipt(vault, "standalone")) };
    });
    const syncPeers = vi.fn(() => {
      events.push("peer");
      expect(existsSync(lockPath)).toBe(true);
      return nonblockingPeerCheck();
    });
    const mutate = vi.fn(async (receipt: ManagedWriteReceipt) => {
      events.push("mutate");
      expect(receipt.mode).toBe("standalone");
      expect(existsSync(lockPath)).toBe(true);
      return { exitCode: 77, result: ok({ accepted: true }) };
    });

    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "test peer gate",
        allowImmutableRecord: false,
        preflight,
        mutate,
      },
      { converge: vi.fn(), syncPeers },
    );

    expect(run).toMatchObject({ exitCode: 77, result: { ok: true, data: { accepted: true } } });
    expect(events).toEqual(["preflight", "peer", "mutate"]);
    expect(syncPeers).toHaveBeenCalledTimes(1);
    expect(syncPeers).toHaveBeenCalledWith({ vault: resolve(vault) });
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each(["standalone", "immutable-record", "git-writer"] as const)(
    "gates the %s transaction mode",
    async (mode) => {
      const vault = mkdtempSync(join(tmpdir(), `managed-peer-gate-${mode}-`));
      const syncPeers = vi.fn(nonblockingPeerCheck);
      const mutate = vi.fn(async () => ({ exitCode: ExitCode.OK, result: ok({ mode }) }));
      const run = await runManagedWriteTransaction(
        {
          vault,
          command: "test peer gate mode",
          allowImmutableRecord: mode === "immutable-record",
          preflight: async () => ({
            exitCode: ExitCode.OK,
            result: ok(makeReceipt(vault, mode)),
          }),
          mutate,
        },
        { converge: vi.fn(), syncPeers },
      );

      expect(run).toMatchObject({ exitCode: ExitCode.OK, result: { ok: true, data: { mode } } });
      expect(syncPeers).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledTimes(1);
    },
  );

  it("ignores live writer overlap for standalone vaults", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-peer-gate-standalone-writer-"));
    const mutate = vi.fn(async () => ({ exitCode: ExitCode.OK, result: ok({ mutated: true }) }));
    const syncPeers = vi.fn(() => ({
      exitCode: ExitCode.OK,
      result: ok(
        makePeerOutput({
          managed_writers: { count: 1, kinds: ["wiki-push"], blocking: true },
          blocking: true,
        }),
      ),
    }));
    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "test standalone writer scope",
        allowImmutableRecord: false,
        preflight: async () => ({
          exitCode: ExitCode.OK,
          result: ok(makeReceipt(vault, "standalone")),
        }),
        mutate,
      },
      { converge: vi.fn(), syncPeers },
    );

    expect(run).toMatchObject({ exitCode: ExitCode.OK, result: { ok: true, data: { mutated: true } } });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "live writer overlap",
      output: makePeerOutput({
        managed_writers: { count: 2, kinds: ["vault-sync"], blocking: true },
        blocking: true,
      }),
      reason: "live-writer-overlap",
    },
    {
      label: "foreign lock",
      output: makePeerOutput({
        locks: [
          {
            session_id: "peer-session",
            pid: 42,
            cwd: "/private/peer-vault",
            summary: "secret peer command",
            acquired: "2026-08-03T00:00:00.000Z",
            expires: "2026-08-03T01:00:00.000Z",
            is_self: false,
          },
        ],
        blocking: true,
      }),
      reason: "peer-lock",
    },
    {
      label: "recent peer stash",
      output: makePeerOutput({
        stash_audit: [
          {
            ref: "refs/stash@{0}",
            oid: "stash-oid",
            age_minutes: 5,
            classification: "recent_known_peer_stash",
            format: "vault-sync",
            operation_id: "secret-operation-id",
          },
        ],
        blocking: true,
      }),
      reason: "recent-peer-stash",
    },
    {
      label: "other valid blocking result",
      output: makePeerOutput({ blocking: true }),
      reason: "peer-blocked",
    },
  ])("blocks mutation for $label with a stable reason", async ({ output, reason }) => {
    const vault = mkdtempSync(join(tmpdir(), "managed-peer-gate-blocked-"));
    const mutate = vi.fn(async () => ({ exitCode: ExitCode.OK, result: ok({ mutated: true }) }));
    const syncPeers = vi.fn(() => ({ exitCode: ExitCode.OK, result: ok(output) }));
    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "test peer gate blocked",
        allowImmutableRecord: false,
        preflight: async () => ({
          exitCode: ExitCode.OK,
          result: ok(makeReceipt(vault, "git-writer")),
        }),
        mutate,
      },
      { converge: vi.fn(), syncPeers },
    );

    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: { reason },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed output",
      syncPeers: () => ({
        exitCode: ExitCode.OK,
        result: ok({ blocking: false } as unknown as SyncPeersOutput),
      }),
    },
    {
      label: "non-OK checker result",
      syncPeers: () => ({
        exitCode: ExitCode.INTERNAL_ERROR,
        result: err("INTERNAL_ERROR", { command: "/private/secret/process" }),
      }),
    },
    {
      label: "throwing checker",
      syncPeers: () => {
        throw new Error("/private/secret/process --pid 42 stash-body");
      },
    },
  ])("fails closed for a $label without leaking checker details", async ({ syncPeers }) => {
    const vault = mkdtempSync(join(tmpdir(), "managed-peer-gate-failed-"));
    const mutate = vi.fn(async () => ({ exitCode: ExitCode.OK, result: ok({ mutated: true }) }));
    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "test peer gate failed",
        allowImmutableRecord: false,
        preflight: async () => ({
          exitCode: ExitCode.OK,
          result: ok(makeReceipt(vault, "standalone")),
        }),
        mutate,
      },
      { converge: vi.fn(), syncPeers },
    );

    expect(run.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(run.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: { reason: "peer-check-failed" },
    });
    expect(JSON.stringify(run.result)).not.toContain("/private/secret/process");
    expect(JSON.stringify(run.result)).not.toContain("stash-body");
    expect(JSON.stringify(run.result)).not.toContain("42");
    expect(mutate).not.toHaveBeenCalled();
  });

  it("allows stale nonblocking stash audits to reach mutation", async () => {
    const vault = mkdtempSync(join(tmpdir(), "managed-peer-gate-stale-"));
    const mutate = vi.fn(async () => ({ exitCode: ExitCode.OK, result: ok({ mutated: true }) }));
    const syncPeers = vi.fn(() => ({
      exitCode: ExitCode.OK,
      result: ok(
        makePeerOutput({
          stash_audit: [
            {
              ref: "refs/stash@{0}",
              oid: "stale-oid",
              age_minutes: 121,
              classification: "stale_stash_backlog",
              format: "vault-sync",
              operation_id: "old-operation",
            },
          ],
        }),
      ),
    }));
    const run = await runManagedWriteTransaction(
      {
        vault,
        command: "test peer gate stale",
        allowImmutableRecord: false,
        preflight: async () => ({
          exitCode: ExitCode.OK,
          result: ok(makeReceipt(vault, "standalone")),
        }),
        mutate,
      },
      { converge: vi.fn(), syncPeers },
    );

    expect(run).toMatchObject({ exitCode: ExitCode.OK, result: { ok: true, data: { mutated: true } } });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
