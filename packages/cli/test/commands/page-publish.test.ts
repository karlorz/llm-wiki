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
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/commands/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/commands/sync.js")>();
  return {
    ...actual,
    runSyncPeers: (input: Parameters<typeof actual.runSyncPeers>[0]) =>
      actual.runSyncPeers({ ...input, processSnapshot: "" }),
  };
});

import { ExitCode } from "@skillwiki/shared";
import {
  defaultPagePublishDeps,
  preparePagePublication,
  preparePagePublicationFromContent,
  projectSlugsForPublication,
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

  it("rejects publication pre-mutation when a foreign peer lock is held", async () => {
    const vault = makeVault(["research"]);
    const before = snapshotFiles(vault);
    mkdirSync(dirname(lockPath(vault)), { recursive: true });
    const held = JSON.stringify({
      session_id: "other-publisher",
      owner_token: "other-owner",
      pid: 0,
      cwd: "fixture-vault",
      summary: "fixture peer lock",
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

    expect(result.exitCode).toBe(ExitCode.PREFLIGHT_FAILED);
    expect(result.result).toMatchObject({
      ok: false,
      error: "PREFLIGHT_FAILED",
      detail: {
        reason: "peer-lock",
        foreign_lock_count: 1,
        blocking: true,
      },
    });
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
    expect(stages).toEqual(["schema", "page", "verify", "index", "unlock", "event", "log"]);
  });

  it("refreshes a project knowledge index for a provenance-linked typed page", async () => {
    const vault = makeVault(["research"]);
    mkdirSync(join(vault, "projects", "demo", "work", "2026-08-02-existing"), { recursive: true });
    writeFileSync(
      join(vault, "projects", "demo", "work", "2026-08-02-existing", "spec.md"),
      "---\ntitle: Existing\nkind: issue\nstatus: completed\nproject: \"[[demo]]\"\n---\n# Existing\n",
    );
    writeFileSync(join(vault, "projects", "demo", "knowledge.md"), "# stale\n");
    const draft = writeDraftBytes(queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[demo]]\"]",
    ));
    const stages: string[] = [];
    const deps = defaultPagePublishDeps({ afterStage: async (stage) => { stages.push(stage); } });

    const preview = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/projected.md",
      write: false,
      now: NOW,
    });
    expect(preview.result).toMatchObject({ ok: true, data: { project_index_updated: true } });

    const published = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/projected.md",
      write: true,
      now: NOW,
    }, deps);
    expect(published.exitCode).toBe(ExitCode.OK);
    expect(stages).toContain("project-index");
    expect(readFileSync(join(vault, "projects", "demo", "knowledge.md"), "utf8")).toContain(
      "[[queries/projected]]",
    );
  });

  it("derives a stable union of path and provenance project slugs", () => {
    const content = queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[beta]]\", \"[[alpha]]\", \"[[beta]]\", \"[[bad/slug]]\"]",
    );
    expect(projectSlugsForPublication("projects/demo/work/2026-08-02-item/spec.md", content)).toEqual([
      "alpha",
      "beta",
      "demo",
    ]);
  });

  it("refreshes every existing project in a multi-provenance publication", async () => {
    const vault = makeVault(["research"]);
    for (const slug of ["alpha", "beta"]) {
      mkdirSync(join(vault, "projects", slug), { recursive: true });
      writeFileSync(join(vault, "projects", slug, "knowledge.md"), "# stale\n");
    }
    const draft = writeDraftBytes(queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[beta]]\", \"[[alpha]]\"]",
    ));
    const preview = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/multi-project.md",
      write: false,
      now: NOW,
    });
    expect(preview.result).toMatchObject({ ok: true, data: { project_index_updated: true } });

    const published = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/multi-project.md",
      write: true,
      now: NOW,
    });
    expect(published.exitCode).toBe(ExitCode.OK);
    for (const slug of ["alpha", "beta"]) {
      expect(readFileSync(join(vault, "projects", slug, "knowledge.md"), "utf8")).toContain(
        "[[queries/multi-project]]",
      );
    }
  });

  it("returns PROJECT_NOT_FOUND before mutating a missing provenance project", async () => {
    const vault = makeVault(["research"]);
    const draft = writeDraftBytes(queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[missing]]\"]",
    ));
    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/missing-project.md",
      write: false,
      now: NOW,
    });
    expect(result.exitCode).toBe(ExitCode.PROJECT_NOT_FOUND);
    expect(existsSync(join(vault, "queries", "missing-project.md"))).toBe(false);
    expect(indexLinks(vault, "queries/missing-project")).toBe(0);
  });

  it("surfaces a project-index write failure without pretending publication completed", async () => {
    const vault = makeVault(["research"]);
    mkdirSync(join(vault, "projects", "blocked"), { recursive: true });
    mkdirSync(join(vault, "projects", "blocked", "knowledge.md"));
    const draft = writeDraftBytes(queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[blocked]]\"]",
    ));
    const result = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/blocked-project.md",
      write: true,
      now: NOW,
    });
    expect(result.exitCode).toBe(ExitCode.WRITE_FAILED);
    expect(result.result).toMatchObject({ ok: false, detail: { stage: "project-index" } });
  });

  it("retries safely after a project-index stage failure", async () => {
    const vault = makeVault(["research"]);
    mkdirSync(join(vault, "projects", "retry"), { recursive: true });
    writeFileSync(join(vault, "projects", "retry", "knowledge.md"), "# stale\n");
    const draft = writeDraftBytes(queryDraft(["research", "novel"]).replace(
      "sources: [raw/articles/source.md]",
      "sources: [raw/articles/source.md]\nprovenance_projects: [\"[[retry]]\"]",
    ));
    const failing = defaultPagePublishDeps({
      afterStage: async (stage) => {
        if (stage === "project-index") throw new Error("injected project-index stop");
      },
    });
    const input = {
      vault,
      draftPath: draft,
      target: "queries/retry-project.md",
      write: true,
      now: NOW,
    };
    const failed = await runPagePublish(input, failing);
    expect(failed.result).toMatchObject({
      ok: false,
      detail: { stage: "project-index", published: true, retry_safe: true },
    });
    const retried = await runPagePublish(input);
    expect(retried.exitCode).toBe(ExitCode.OK);
    expect(readFileSync(join(vault, "projects", "retry", "knowledge.md"), "utf8")).toContain(
      "[[queries/retry-project]]",
    );
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

describe("page publish managed write receipt", () => {
  it("exposes frozen base_oid and write_mode on write", async () => {
    const { execFileSync } = await import("node:child_process");
    const { ok } = await import("@skillwiki/shared");
    const { publishPreparedPage } = await import("../../src/commands/page-publish.js");

    const vault = makeVault(["research"]);
    execFileSync("git", ["init"], { cwd: vault });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: vault });
    execFileSync("git", ["config", "user.name", "t"], { cwd: vault });
    execFileSync("git", ["add", "."], { cwd: vault });
    execFileSync("git", ["commit", "-m", "init"], { cwd: vault });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: vault, encoding: "utf8" }).trim();

    const prepared = preparePagePublicationFromContent({
      vault,
      content: queryDraft(["research"], "Receipt Query"),
      target: "queries/receipt-query.md",
      now: NOW,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const deps = defaultPagePublishDeps({
      preflight: async () => ({
        exitCode: 0,
        result: ok({
          mode: "git-writer",
          host_id: "macos-dev",
          mutation_vault: vault,
          git_vault: vault,
          convergence_source: "single-path",
          base_oid: head,
          converged: true,
        }),
      }),
    });
    const run = await publishPreparedPage(prepared.data, vault, deps);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        base_oid: head,
        write_mode: "git-writer",
        host_id: "macos-dev",
      },
    });
  });

  it("checks the frozen base OID in the receipt Git vault, not the live mutation vault", async () => {
    const { execFileSync } = await import("node:child_process");
    const { ok } = await import("@skillwiki/shared");
    const { publishPreparedPage } = await import("../../src/commands/page-publish.js");

    const liveVault = makeVault(["research"]);
    const gitVault = makeVault(["research"]);
    execFileSync("git", ["init"], { cwd: gitVault });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: gitVault });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitVault });
    execFileSync("git", ["add", "."], { cwd: gitVault });
    execFileSync("git", ["commit", "-m", "init"], { cwd: gitVault });
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitVault,
      encoding: "utf8",
    }).trim();

    const prepared = preparePagePublicationFromContent({
      vault: liveVault,
      content: queryDraft(["research"], "Dual Path Receipt Query"),
      target: "queries/dual-path-receipt-query.md",
      now: NOW,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const deps = defaultPagePublishDeps({
      preflight: async () => ({
        exitCode: 0,
        result: ok({
          mode: "git-writer",
          host_id: "sg01",
          mutation_vault: liveVault,
          convergence_vault: gitVault,
          git_vault: gitVault,
          convergence_source: "configured",
          base_oid: head,
          converged: true,
        }),
      }),
    });

    const run = await publishPreparedPage(prepared.data, liveVault, deps);

    expect(run.exitCode).toBe(ExitCode.OK);
    expect(run.result).toMatchObject({
      ok: true,
      data: {
        base_oid: head,
        write_mode: "git-writer",
        mutation_vault: liveVault,
        git_vault: gitVault,
      },
    });
  });

  it("emits approval tokens on dry-run and remains compatible without --approve", async () => {
    const vault = makeVault(["research"]);
    const draft = writeQueryDraft(["research", "novel"]);

    const dry = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "approval canary",
      write: false,
      now: NOW,
    });
    expect(dry.exitCode).toBe(ExitCode.OK);
    if (!dry.result.ok) return;
    expect(dry.result.data.approval_token).toMatch(/^swpub1\./);
    expect(dry.result.data.draft_sha256).toMatch(/^[0-9a-f]{64}$/);

    const withoutApprove = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "approval canary",
      write: true,
      now: NOW,
    });
    expect(withoutApprove.exitCode).toBe(ExitCode.OK);
  });

  it("validates --approve before mutation and rejects project-page tokens", async () => {
    const vault = makeVault(["research"]);
    const draft = writeQueryDraft(["research", "novel"]);
    const before = snapshotFiles(vault);

    const approveOnly = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      write: false,
      approve: "swpub1.x.y",
      now: NOW,
    });
    expect(approveOnly.exitCode).toBe(ExitCode.USAGE);

    const invalid = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      write: true,
      approve: "swpub1.invalid.token",
      now: NOW,
    });
    expect(invalid.exitCode).toBe(ExitCode.APPROVAL_INVALID);
    expect(snapshotFiles(vault)).toEqual(before);

    const dry = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "ok",
      write: false,
      now: NOW,
    });
    if (!dry.result.ok) return;
    const token = dry.result.data.approval_token!;

    // Cross-command: project-page token rejected by page publish.
    const { encodeApprovalToken, sha256Hex } = await import("../../src/utils/publication-approval.js");
    const content = readFileSync(draft, "utf8");
    const projectToken = encodeApprovalToken({
      contract: "skillwiki-publication-approval-v1",
      publisher: "project-page",
      draft_sha256: sha256Hex(content),
      target: "queries/novel.md",
      project: "llm-wiki",
      log_note: "ok",
      prior_target_sha256: "absent",
    });
    expect(projectToken.ok).toBe(true);
    if (!projectToken.ok) return;
    const cross = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "ok",
      write: true,
      approve: projectToken.data,
      now: NOW,
    });
    expect(cross.exitCode).toBe(ExitCode.APPROVAL_MISMATCH);
    expect(snapshotFiles(vault)).toEqual(before);

    const approved = await runPagePublish({
      vault,
      draftPath: draft,
      target: "queries/novel.md",
      logNote: "ok",
      write: true,
      approve: token,
      now: NOW,
    });
    expect(approved.exitCode).toBe(ExitCode.OK);
    expect(existsSync(join(vault, "queries", "novel.md"))).toBe(true);
  });
});
