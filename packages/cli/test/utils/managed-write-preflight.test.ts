import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { ExitCode, err, ok } from "@skillwiki/shared";
import {
  runManagedWritePreflight,
  runManagedWriteTransaction,
} from "../../src/utils/managed-write-preflight.js";
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
      { converge },
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
      { converge },
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
        hostId: "sg01",
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
      ok({ before_oid: null, after_oid: null, changed: false, helper_path: "/test/helper" }),
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
});
