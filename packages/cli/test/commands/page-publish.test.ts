import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExitCode } from "@skillwiki/shared";
import {
  defaultPagePublishDeps,
  preparePagePublication,
  preparePagePublicationFromContent,
  runPagePublish,
} from "../../src/commands/page-publish.js";
import { lockPath, readLock } from "../../src/utils/sync-lock.js";

const NOW = new Date("2026-07-13T00:00:00Z");

function makeVault(tags: string[] = ["research"]): string {
  const vault = mkdtempSync(join(tmpdir(), "page-publish-vault-"));
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
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Queries\n");
  writeFileSync(join(vault, "log.md"), "# Vault Log\n");
  for (const directory of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, directory), { recursive: true });
  }
  return vault;
}

function queryDraft(tags: string[] = ["research", "novel"], title = "Novel Query"): string {
  return `---
title: ${title}
aliases: []
created: 2026-07-13
updated: 2026-07-13
type: query
tags: [${tags.join(", ")}]
sources: [raw/articles/source.md]
confidence: medium
---

# ${title}

## Sources

- ^[raw/articles/source.md]
`;
}

function writeDraftBytes(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "page-publish-draft-"));
  const draft = join(directory, "draft.md");
  writeFileSync(draft, content);
  return draft;
}

function writeQueryDraft(tags: string[] = ["research", "novel"]): string {
  return writeDraftBytes(queryDraft(tags));
}

function writeSensitiveDraft(): string {
  return writeDraftBytes(`${queryDraft()}\napi_key: sk-${"a".repeat(24)}\n`);
}

function snapshotFiles(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, relative = "") => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const key = relative ? `${relative}/${name}` : name;
      if (lstatSync(path).isDirectory()) visit(path, key);
      else result[key] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return result;
}

function readSchema(vault: string): string {
  return readFileSync(join(vault, "SCHEMA.md"), "utf8");
}

function operationMarkers(vault: string): number {
  return (readFileSync(join(vault, "log.md"), "utf8").match(/skillwiki-page-publish:/g) ?? []).length;
}

function indexLinks(vault: string, target: string): number {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (readFileSync(join(vault, "index.md"), "utf8").match(new RegExp(`\\[\\[${escaped}\\]\\]`, "g")) ?? []).length;
}

describe("page publish", () => {
  it("dry-runs the complete receipt without locks or writes", async () => {
    const vault = makeVault(["research"]);
    const draft = writeQueryDraft(["research", "novel"]);
    const before = snapshotFiles(vault);

    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "research-cycle canary",
      write: false,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        target: "queries/novel.md",
        taxonomy_added: ["novel"],
        dry_run: true,
        page_changed: true,
        index_updated: true,
        log_appended: true,
      },
    });
    expect(snapshotFiles(vault)).toEqual(before);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("rejects sensitive or invalid drafts before SCHEMA mutation", async () => {
    const vault = makeVault(["research"]);
    const before = snapshotFiles(vault);

    const result = await runPagePublish({
      vault,
      draftPath: writeSensitiveDraft(),
      target: "queries/rejected.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.SENSITIVE_CONTENT_DETECTED);
    expect(result.result).toMatchObject({ ok: false, error: "SENSITIVE_CONTENT_DETECTED" });
    expect(snapshotFiles(vault)).toEqual(before);
  });

  it.each([
    ["direct target alias", (vault: string) => join(vault, "queries", "existing.md")],
    ["draft symlink alias", (vault: string) => {
      const target = join(vault, "queries", "existing.md");
      const aliasDirectory = mkdtempSync(join(tmpdir(), "page-publish-alias-"));
      const alias = join(aliasDirectory, "draft.md");
      symlinkSync(target, alias);
      return alias;
    }],
  ])("rejects a %s draft that aliases the existing target", async (_name, draftFor) => {
    const vault = makeVault();
    const target = join(vault, "queries", "existing.md");
    writeFileSync(target, queryDraft(["research"]));

    const result = await runPagePublish({
      vault,
      draftPath: draftFor(vault),
      target: "queries/existing.md",
      write: false,
    });

    expect(result.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(result.result).toMatchObject({ ok: false, error: "VAULT_PATH_INVALID" });
  });

  it("rejects target symlinks, missing directories, and non-normalized targets", async () => {
    const vault = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "page-publish-outside-"));
    writeFileSync(join(outside, "outside.md"), queryDraft(["research"]));
    symlinkSync(join(outside, "outside.md"), join(vault, "queries", "alias.md"));

    for (const target of ["queries/alias.md", "queries/missing/new.md", "queries/../escape.md"]) {
      const result = await runPagePublish({ vault, draftPath: writeQueryDraft(), target, write: false });
      expect(result.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
      expect(result.result).toMatchObject({ ok: false, error: "VAULT_PATH_INVALID" });
    }
  });

  it("rejects invalid log notes and a page type mismatch before writing", async () => {
    const vault = makeVault();
    const before = snapshotFiles(vault);
    const cases = [
      { target: "queries/novel.md", logNote: "two\nlines" },
      { target: "queries/novel.md", logNote: "a".repeat(501) },
      { target: "concepts/novel.md", logNote: undefined },
    ];

    for (const input of cases) {
      const result = await runPagePublish({ vault, draftPath: writeQueryDraft(), write: true, ...input });
      expect(result.result.ok).toBe(false);
      expect(snapshotFiles(vault)).toEqual(before);
    }
  });

  it("does not mutate any publication files for an invalid newly missing tag", async () => {
    const vault = makeVault(["research"]);
    const before = snapshotFiles(vault);

    const result = await runPagePublish({
      vault,
      draftPath: writeQueryDraft(["research", "not valid"]),
      target: "queries/rejected.md",
      write: true,
      now: NOW,
    });

    expect(result.exitCode).toBe(ExitCode.SCHEME_REJECTED);
    expect(snapshotFiles(vault)).toEqual(before);
  });

  it("does not write or release a publication lock held by another owner", async () => {
    const vault = makeVault(["research"]);
    const before = snapshotFiles(vault);
    mkdirSync(dirname(lockPath(vault)), { recursive: true });
    const held = JSON.stringify({
      session_id: "other-publisher",
      owner_token: "other-owner",
      acquired: NOW.toISOString(),
      expires: "2026-07-13T00:01:00.000Z",
    });
    writeFileSync(lockPath(vault), held);

    const result = await runPagePublish({
      vault,
      draftPath: writeQueryDraft(),
      target: "queries/novel.md",
      write: true,
    });

    expect(result.exitCode).toBe(ExitCode.SYNC_LOCK_HELD);
    expect(snapshotFiles(vault)).toEqual({ ...before, ".skillwiki/sync.lock": held });
    expect(readFileSync(lockPath(vault), "utf8")).toBe(held);
  });

  it("gives file and in-memory preparation the same frozen operation ID", async () => {
    const vault = makeVault(["research"]);
    const content = queryDraft(["research", "novel"]);
    const draftPath = writeDraftBytes(content);
    const filePrepared = await preparePagePublication({
      vault,
      draftPath,
      target: "queries/novel.md",
      logNote: "same input",
      write: false,
      now: NOW,
    });
    const contentPrepared = preparePagePublicationFromContent({
      vault,
      content,
      target: "queries/novel.md",
      logNote: "same input",
      now: NOW,
    });

    expect(filePrepared).toMatchObject({ ok: true });
    expect(contentPrepared).toMatchObject({ ok: true });
    if (!filePrepared.ok || !contentPrepared.ok) return;
    expect(contentPrepared.data.operationId).toBe(filePrepared.data.operationId);
    expect(contentPrepared.data.page.content).toBe(filePrepared.data.page.content);
  });

  it("publishes schema before page and page before index, unlock, and log", async () => {
    const vault = makeVault(["research"]);
    const stages: string[] = [];
    const deps = defaultPagePublishDeps({ afterStage: async (stage) => { stages.push(stage); } });

    const result = await runPagePublish({
      vault,
      draftPath: writeQueryDraft(["research", "novel"]),
      target: "queries/novel.md",
      logNote: "ordered publish",
      write: true,
      now: NOW,
    }, deps);

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(stages).toEqual(["schema", "page", "verify", "index", "unlock", "log"]);
  });

  it("leaves a harmless schema superset when publication stops before the page stage", async () => {
    const vault = makeVault(["research"]);
    const deps = defaultPagePublishDeps({
      afterStage: async (stage) => {
        if (stage === "schema") throw new Error("injected schema-to-page stop");
      },
    });

    const result = await runPagePublish({
      vault,
      draftPath: writeQueryDraft(["research", "novel"]),
      target: "queries/novel.md",
      write: true,
      now: NOW,
    }, deps);

    expect(result.exitCode).toBe(ExitCode.WRITE_FAILED);
    expect(readSchema(vault)).toContain("  - novel");
    expect(existsSync(join(vault, "queries", "novel.md"))).toBe(false);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("reports published true and completes derived writes on retry", async () => {
    const vault = makeVault(["research"]);
    const failing = defaultPagePublishDeps({
      afterStage: async (stage) => {
        if (stage === "log") throw new Error("injected log failure");
      },
    });
    const input = {
      vault,
      draftPath: writeQueryDraft(["research", "novel"]),
      target: "queries/novel.md",
      logNote: "retry fixture",
      write: true,
      now: NOW,
    };

    const failed = await runPagePublish(input, failing);
    expect(failed.result).toMatchObject({
      ok: false,
      detail: { stage: "log", published: true, retry_safe: true },
    });
    const retried = await runPagePublish(input);
    expect(retried.exitCode).toBe(ExitCode.OK);
    expect(indexLinks(vault, "queries/novel")).toBe(1);
    expect(operationMarkers(vault)).toBe(1);
  });

  it("reports unlock failure and preserves a successor lock", async () => {
    const vault = makeVault(["research"]);
    const successor = {
      session_id: "successor",
      owner_token: "b".repeat(32),
      acquired: NOW.toISOString(),
      expires: "2026-07-13T00:01:00.000Z",
    };
    const deps = defaultPagePublishDeps({
      afterStage: async (stage) => {
        if (stage === "index") writeFileSync(lockPath(vault), JSON.stringify(successor, null, 2) + "\n");
      },
    });

    const result = await runPagePublish({
      vault,
      draftPath: writeQueryDraft(["research", "novel"]),
      target: "queries/novel.md",
      write: true,
      now: NOW,
    }, deps);

    expect(result.result).toMatchObject({
      ok: false,
      detail: { stage: "unlock", published: true, primary_stage: "complete" },
    });
    expect(readLock(vault)?.owner_token).toBe(successor.owner_token);
  });
});
