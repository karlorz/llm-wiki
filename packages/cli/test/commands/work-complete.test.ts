import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { err } from "@skillwiki/shared";
import {
  defaultWorkCompleteDeps,
  runWorkComplete,
} from "../../src/commands/work-complete.js";
import { operationId } from "../../src/utils/operation-id.js";

const CLI_BIN = join(__dirname, "..", "..", "dist", "cli.js");

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
      encoding: "utf8",
      env: { ...process.env, AUTO_COMMIT: "false", ...env },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

function commitCount(repo: string): number {
  const out = execFileSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  return Number(out);
}

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-wc-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  writeFileSync(join(dir, "log.md"), "# Vault Log\n\n");
  writeFileSync(join(dir, "index.md"), "# Index\n");
  return dir;
}

function makeWorkItem(vault: string, slug = "projects/demo/work/2026-07-20-sample"): string {
  const abs = join(vault, slug);
  mkdirSync(abs, { recursive: true });
  writeFileSync(
    join(abs, "spec.md"),
    `---
title: sample work
name: sample
status: in-progress
kind: issue
---

# Sample

Body.
`,
  );
  writeFileSync(
    join(abs, "plan.md"),
    `---
title: plan
status: in-progress
---

# Plan

- [ ] step one
- [ ] step two
`,
  );
  return slug;
}

describe("runWorkComplete", () => {
  it("completes a work item and is idempotent on retry with same operation id", async () => {
    const vault = makeVault();
    const workItem = makeWorkItem(vault);
    const opId = operationId("skillwiki-work-complete-v1", [vault, workItem]);

    const first = await runWorkComplete({
      vault,
      workItem,
      operationId: opId,
      noCommit: true,
    });
    expect(first.exitCode).toBe(0);
    expect(first.result).toMatchObject({
      ok: true,
      data: { completed: true, operation_id: opId },
    });
    expect(existsSync(join(vault, workItem, "evidence.md"))).toBe(true);
    expect(readFileSync(join(vault, workItem, "spec.md"), "utf8")).toMatch(/status: completed/);
    expect(readFileSync(join(vault, workItem, "plan.md"), "utf8")).toMatch(/- \[x\] step one/);

    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(log.match(/skillwiki-log-op:/g)?.length ?? 0).toBe(1);
    const events = readdirSync(join(vault, "meta", "log-events"), { recursive: true })
      .filter((f) => String(f).endsWith(".json"));
    expect(events).toHaveLength(1);

    const second = await runWorkComplete({
      vault,
      workItem,
      operationId: opId,
      noCommit: true,
    });
    expect(second.exitCode).toBe(0);
    expect(second.result).toMatchObject({
      ok: true,
      data: { completed: true, retried: true },
    });
    // no double log markers
    expect(readFileSync(join(vault, "log.md"), "utf8").match(/skillwiki-log-op:/g)).toHaveLength(1);
    expect(
      readdirSync(join(vault, "meta", "log-events"), { recursive: true })
        .filter((f) => String(f).endsWith(".json")),
    ).toHaveLength(1);
  });

  it("evidence write failure returns WRITE_FAILED and does not advance journal past evidence", async () => {
    const vault = makeVault();
    const workItem = makeWorkItem(vault, "projects/demo/work/2026-07-20-write-fail");
    const opId = operationId("skillwiki-work-complete-v1", [vault, workItem, "write-fail"]);

    const failed = await runWorkComplete(
      {
        vault,
        workItem,
        operationId: opId,
        noCommit: true,
      },
      defaultWorkCompleteDeps({
        writeEvidenceText: async (path) =>
          err("WRITE_FAILED", {
            path,
            phase: "atomic-write",
            message: "simulated evidence write failure",
          }),
      }),
    );

    expect(failed.exitCode).toBe(10); // WRITE_FAILED
    expect(failed.result.ok).toBe(false);
    const journal = readFileSync(
      join(vault, ".skillwiki", "work-complete", `${opId}.env`),
      "utf8",
    );
    // Journal advanced into evidence but must not reach log/done on write failure
    expect(journal).toMatch(/phase=evidence/);
    expect(journal).not.toMatch(/phase=log/);
    expect(journal).not.toMatch(/phase=done/);
    expect(readFileSync(join(vault, "log.md"), "utf8")).not.toMatch(/skillwiki-log-op:/);
  });

  it("CLI --no-commit does not create a git commit (shipped binary path)", () => {
    // Drive packages/cli/dist/cli.js so Commander flag binding is exercised.
    if (!existsSync(CLI_BIN)) {
      throw new Error(`missing built CLI at ${CLI_BIN}; run npm run build in packages/cli`);
    }

    const vault = makeVault();
    execFileSync("git", ["init", "-b", "main"], { cwd: vault });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: vault });
    execFileSync("git", ["config", "user.name", "t"], { cwd: vault });
    execFileSync("git", ["add", "-A"], { cwd: vault });
    execFileSync("git", ["commit", "-m", "init"], { cwd: vault });

    const workItem = makeWorkItem(vault, "projects/demo/work/2026-07-20-cli-nocommit");
    const before = commitCount(vault);
    expect(before).toBe(1);

    const opId = operationId("skillwiki-work-complete-v1", [vault, workItem, "cli-no-commit"]);
    const result = runCli([
      "work-complete",
      vault,
      "--work-item",
      workItem,
      "--operation-id",
      opId,
      "--no-commit",
    ]);

    expect(result.status, `cli failed: ${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      data?: { committed?: boolean; completed?: boolean };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data?.completed).toBe(true);
    expect(payload.data?.committed).toBe(false);
    expect(commitCount(vault)).toBe(before);
    expect(existsSync(join(vault, workItem, "evidence.md"))).toBe(true);
  });

  it("resumes after simulated mid-transaction failure without double commit", async () => {
    const vault = makeVault();
    execFileSync("git", ["init", "-b", "main"], { cwd: vault });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: vault });
    execFileSync("git", ["config", "user.name", "t"], { cwd: vault });
    execFileSync("git", ["add", "-A"], { cwd: vault });
    execFileSync("git", ["commit", "-m", "init"], { cwd: vault });

    const workItem = makeWorkItem(vault);
    const opId = operationId("skillwiki-work-complete-v1", [vault, workItem, "retry-case"]);

    const failed = await runWorkComplete({
      vault,
      workItem,
      operationId: opId,
      failAfter: "evidence",
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.result.ok).toBe(false);

    // evidence may already exist; journal should be resumable
    const journal = readFileSync(
      join(vault, ".skillwiki", "work-complete", `${opId}.env`),
      "utf8",
    );
    expect(journal).toMatch(/phase=/);

    const resumed = await runWorkComplete({
      vault,
      workItem,
      operationId: opId,
    });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.result).toMatchObject({
      ok: true,
      data: { completed: true, retried: true },
    });

    // single completion commit message at most once
    const log = execFileSync("git", ["log", "--oneline"], { cwd: vault, encoding: "utf8" });
    const completeCommits = log.split("\n").filter((l) => l.includes("work-complete:"));
    expect(completeCommits.length).toBeLessThanOrEqual(1);

    // one log op marker
    expect(readFileSync(join(vault, "log.md"), "utf8").match(/skillwiki-log-op:/g)).toHaveLength(1);
  });
});
