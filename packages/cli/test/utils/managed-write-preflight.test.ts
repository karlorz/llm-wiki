import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ExitCode, ok } from "@skillwiki/shared";
import { runManagedWritePreflight } from "../../src/utils/managed-write-preflight.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
});
