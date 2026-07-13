import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExitCode } from "@skillwiki/shared";

const ownedLockFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("../../src/utils/sync-lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/sync-lock.js")>();
  return {
    ...actual,
    acquireOwnedSyncLock: (...args: Parameters<typeof actual.acquireOwnedSyncLock>) => (
      ownedLockFailure.enabled
        ? { ok: false as const, error: "WRITE_FAILED" }
        : actual.acquireOwnedSyncLock(...args)
    ),
  };
});

import { runTagReconcile } from "../../src/commands/tag-reconcile.js";
import { lockPath } from "../../src/utils/sync-lock.js";

const NOW = new Date("2026-07-13T00:00:00Z");

function makeVault(tags: string[]): string {
  const vault = mkdtempSync(join(tmpdir(), "tag-reconcile-vault-"));
  writeFileSync(join(vault, "SCHEMA.md"), `# Vault Schema

Keep this prose and its formatting intact.

## Tag Taxonomy

\`\`\`yaml
taxonomy:
${tags.map((tag) => `  - ${tag}`).join("\n")}
\`\`\`

## Other Schema Content

Unrelated content remains unchanged.
`);
  for (const directory of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, directory), { recursive: true });
  }
  return vault;
}

function writeDraft(tags: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "tag-reconcile-draft-"));
  const file = join(directory, "draft.md");
  const value = Array.isArray(tags) ? `[${tags.join(", ")}]` : String(tags);
  writeFileSync(file, `---
title: Draft
tags: ${value}
---

Draft body.
`);
  return file;
}

function writePage(vault: string, page: string, tags: unknown): void {
  const path = join(vault, page);
  mkdirSync(dirname(path), { recursive: true });
  const value = Array.isArray(tags) ? `[${tags.join(", ")}]` : String(tags);
  writeFileSync(path, `---
title: Existing
tags: ${value}
---

Existing page body.
`);
}

describe("runTagReconcile", () => {
  afterEach(() => {
    ownedLockFailure.enabled = false;
  });

  it("reports prospective missing tags without writing or locking", async () => {
    const vault = makeVault(["research"]);
    const before = readFileSync(join(vault, "SCHEMA.md"), "utf8");

    const result = await runTagReconcile({
      vault,
      page: "queries/2026-07-13-research-cycle-325-report.md",
      tags: ["research", "new-tag"],
      write: false,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        requested_tags: ["new-tag", "research"],
        missing_tags: ["new-tag"],
        added_tags: [],
        changed: true,
        dry_run: true,
        files_changed: [],
      },
    });
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toBe(before);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("unions explicit tags with an unpublished draft", async () => {
    const vault = makeVault(["research"]);
    const draft = writeDraft(["research", "from-draft"]);

    const result = await runTagReconcile({
      vault,
      page: "queries/report.md",
      from: draft,
      tags: ["explicit"],
      write: false,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        requested_tags: ["explicit", "from-draft", "research"],
        missing_tags: ["explicit", "from-draft"],
      },
    });
  });

  it("reads tags from an existing target when no prospective source is provided", async () => {
    const vault = makeVault(["research"]);
    writePage(vault, "queries/existing.md", ["research", "from-target"]);

    const result = await runTagReconcile({
      vault,
      page: "queries/existing.md",
      write: false,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: { requested_tags: ["from-target", "research"], missing_tags: ["from-target"] },
    });
  });

  it("rejects a missing target when no explicit or draft tags are supplied", async () => {
    const vault = makeVault(["research"]);

    const result = await runTagReconcile({ vault, page: "queries/missing.md", write: false });

    expect(result.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
    expect(result.result).toMatchObject({ ok: false, error: "FILE_NOT_FOUND" });
  });

  it("rejects a missing draft source", async () => {
    const vault = makeVault(["research"]);

    const result = await runTagReconcile({
      vault,
      page: "queries/prospective.md",
      from: join(vault, "missing-draft.md"),
      write: false,
    });

    expect(result.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
    expect(result.result).toMatchObject({ ok: false, error: "FILE_NOT_FOUND" });
  });

  it("requires draft frontmatter tags to be an array of strings", async () => {
    const vault = makeVault(["research"]);
    const draft = writeDraft("not-an-array");

    const result = await runTagReconcile({ vault, page: "queries/prospective.md", from: draft, write: false });

    expect(result.exitCode).toBe(ExitCode.INVALID_FRONTMATTER);
    expect(result.result).toMatchObject({ ok: false, error: "INVALID_FRONTMATTER" });
  });

  it.each([
    "",
    ".",
    "..",
    "/queries/absolute.md",
    "queries\\backslash.md",
    "queries/../escape.md",
    "queries//double.md",
    "queries/./dot.md",
    "queries/.hidden.md",
    "queries/..hidden.md",
    "raw/not-typed.md",
    "queries/not-markdown.txt",
  ])("rejects invalid typed target path %j", async (page) => {
    const vault = makeVault(["research"]);

    const result = await runTagReconcile({ vault, page, tags: ["research"], write: false });

    expect(result.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(result.result).toMatchObject({ ok: false, error: "VAULT_PATH_INVALID" });
  });

  it("rejects an invalid missing tag without writing", async () => {
    const vault = makeVault(["research"]);
    const before = readFileSync(join(vault, "SCHEMA.md"), "utf8");

    const result = await runTagReconcile({
      vault,
      page: "queries/prospective.md",
      tags: ["not valid"],
      write: false,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.SCHEME_REJECTED);
    expect(result.result).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toBe(before);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("writes one dated block and verifies the result", async () => {
    const vault = makeVault(["research"]);

    const result = await runTagReconcile({
      vault,
      page: "queries/2026-07-13-research-cycle-325-report.md",
      tags: ["zeta", "alpha"],
      write: true,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        added_tags: ["alpha", "zeta"],
        changed: true,
        dry_run: false,
        files_changed: ["SCHEMA.md"],
      },
    });
    const schema = readFileSync(join(vault, "SCHEMA.md"), "utf8");
    expect(schema).toContain("  # -- added 2026-07-13: research-cycle 325 taxonomy reconciliation --\n  - alpha\n  - zeta\n");
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("second write is a no-op with unchanged mtime", async () => {
    const vault = makeVault(["research"]);
    const input = { vault, page: "queries/report.md", tags: ["alpha"], write: true, now: NOW };

    await runTagReconcile(input);
    const before = statSync(join(vault, "SCHEMA.md")).mtimeMs;
    const second = await runTagReconcile(input);

    expect(second.exitCode).toBe(ExitCode.OK);
    expect(second.result).toMatchObject({ ok: true, data: { added_tags: [], changed: false, files_changed: [] } });
    expect(statSync(join(vault, "SCHEMA.md")).mtimeMs).toBe(before);
  });

  it("does not write or release a lock held by another publisher", async () => {
    const vault = makeVault(["research"]);
    const before = readFileSync(join(vault, "SCHEMA.md"), "utf8");
    mkdirSync(join(vault, ".skillwiki"), { recursive: true });
    const held = JSON.stringify({
      session_id: "other-publisher",
      owner_token: "other-owner",
      acquired: NOW.toISOString(),
      expires: "2026-07-13T00:01:00.000Z",
    });
    writeFileSync(lockPath(vault), held);

    const result = await runTagReconcile({
      vault,
      page: "queries/prospective.md",
      tags: ["alpha"],
      write: true,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(result.result).toMatchObject({ ok: false, error: "SYNC_LOCK_HELD" });
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toBe(before);
    expect(readFileSync(lockPath(vault), "utf8")).toBe(held);
  });

  it("returns WRITE_FAILED when owned lock acquisition reports a write failure", async () => {
    const vault = makeVault(["research"]);
    const before = readFileSync(join(vault, "SCHEMA.md"), "utf8");
    ownedLockFailure.enabled = true;

    const result = await runTagReconcile({
      vault,
      page: "queries/prospective.md",
      tags: ["alpha"],
      write: true,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.WRITE_FAILED);
    expect(result.result).toMatchObject({ ok: false, error: "WRITE_FAILED" });
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toBe(before);
  });
});
