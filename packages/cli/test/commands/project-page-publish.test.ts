import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  defaultProjectPagePublishDeps,
  runProjectPagePublish,
} from "../../src/commands/project-page-publish.js";
import { lockPath } from "../../src/utils/sync-lock.js";
import { encodeApprovalToken, sha256Hex } from "../../src/utils/publication-approval.js";

const NOW = new Date("2026-07-27T00:00:00Z");

function makeVault(tags: string[] = ["adr", "research"]): string {
  const vault = mkdtempSync(join(tmpdir(), "project-page-publish-vault-"));
  writeFileSync(
    join(vault, "SCHEMA.md"),
    `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
${tags.map((tag) => `  - ${tag}`).join("\n")}
\`\`\`

## Other Schema Content
`,
  );
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(vault, "log.md"), "# Vault Log\n");
  for (const directory of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, directory), { recursive: true });
  }
  mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
  writeFileSync(
    join(vault, "projects", "llm-wiki", "README.md"),
    "---\ntitle: llm-wiki\n---\n\n# llm-wiki\n",
  );
  return vault;
}

function archDraft(tags: string[] = ["adr", "sync"]): string {
  return `---
title: Example Architecture ADR
aliases: []
created: 2026-07-27
updated: 2026-07-27
type: concept
tags: [${tags.join(", ")}]
sources: [projects/llm-wiki/work/example/spec.md]
confidence: medium
provenance: project
provenance_projects: ["[[llm-wiki]]"]
---

# Example Architecture ADR

Decision body.
`;
}

function writeDraft(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), "project-page-draft-"));
  const draft = join(directory, "draft.md");
  writeFileSync(draft, content);
  return draft;
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

describe("project-page publish", () => {
  it("dry-runs the complete receipt without locks or writes and emits approval token", async () => {
    const vault = makeVault(["adr"]);
    const draft = writeDraft(archDraft(["adr", "novel-tag"]));
    const before = snapshotFiles(vault);
    const journalHome = mkdtempSync(join(tmpdir(), "pp-journal-"));

    const result = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      logNote: "architecture canary",
      write: false,
      now: NOW,
      journalHome,
    });

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(result.result).toMatchObject({
      ok: true,
      data: {
        approval_required: true,
        project: "llm-wiki",
        target: "projects/llm-wiki/architecture/example.md",
        dry_run: true,
        page_changed: true,
        target_before: "absent",
        taxonomy_added: ["novel-tag"],
      },
    });
    if (result.result.ok) {
      expect(result.result.data.approval_token).toMatch(/^swpub1\./);
      expect(result.result.data.operation_id).toMatch(/^[0-9a-f]{64}$/);
      expect(result.result.data.draft_sha256).toBe(sha256Hex(archDraft(["adr", "novel-tag"])));
      expect(result.result.data.files_changed).toEqual(
        expect.arrayContaining([
          "SCHEMA.md",
          "projects/llm-wiki/architecture/example.md",
          "projects/llm-wiki/knowledge.md",
          "log.md",
        ]),
      );
    }
    expect(snapshotFiles(vault)).toEqual(before);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("requires --approve with --write and rejects --approve without --write", async () => {
    const vault = makeVault();
    const draft = writeDraft(archDraft());
    const required = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: true,
      now: NOW,
    });
    expect(required.exitCode).toBe(ExitCode.APPROVAL_REQUIRED);
    expect(existsSync(join(vault, "projects/llm-wiki/architecture/example.md"))).toBe(false);

    const usage = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: false,
      approve: "swpub1.bad.token",
      now: NOW,
    });
    expect(usage.exitCode).toBe(ExitCode.USAGE);
  });

  it("rejects invalid approval before any mutation", async () => {
    const vault = makeVault();
    const draft = writeDraft(archDraft());
    const before = snapshotFiles(vault);
    const result = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: true,
      approve: "swpub1.not-valid.checksum",
      now: NOW,
    });
    expect(result.exitCode).toBe(ExitCode.APPROVAL_INVALID);
    expect(snapshotFiles(vault)).toEqual(before);
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("rejects cross-publisher page tokens", async () => {
    const vault = makeVault();
    const draftContent = archDraft();
    const draft = writeDraft(draftContent);
    const pageToken = encodeApprovalToken({
      contract: "skillwiki-publication-approval-v1",
      publisher: "page",
      draft_sha256: sha256Hex(draftContent),
      target: "projects/llm-wiki/architecture/example.md",
      log_note: "",
      prior_target_sha256: "absent",
    });
    expect(pageToken.ok).toBe(true);
    if (!pageToken.ok) return;
    const result = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      write: true,
      approve: pageToken.data,
      now: NOW,
    });
    expect(result.exitCode).toBe(ExitCode.APPROVAL_MISMATCH);
    expect(existsSync(join(vault, "projects/llm-wiki/architecture/example.md"))).toBe(false);
  });

  it("publishes architecture page, project knowledge, event, and log without root index", async () => {
    const vault = makeVault(["adr"]);
    const draftContent = archDraft(["adr", "topology"]);
    const draft = writeDraft(draftContent);
    const journalHome = mkdtempSync(join(tmpdir(), "pp-journal-"));
    const indexBefore = readFileSync(join(vault, "index.md"), "utf8");

    const preview = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/example.md",
      logNote: "publish canary",
      write: false,
      now: NOW,
      journalHome,
    });
    expect(preview.exitCode).toBe(ExitCode.OK);
    if (!preview.result.ok) return;
    const token = preview.result.data.approval_token!;

    const stages: string[] = [];
    const deps = defaultProjectPagePublishDeps({
      afterStage: async (stage) => {
        stages.push(stage);
      },
    });

    const result = await runProjectPagePublish(
      {
        vault,
        draftPath: draft,
        project: "llm-wiki",
        target: "projects/llm-wiki/architecture/example.md",
        logNote: "publish canary",
        write: true,
        approve: token,
        now: NOW,
        journalHome,
      },
      deps,
    );

    expect(result.exitCode).toBe(ExitCode.OK);
    expect(stages).toEqual([
      "journal",
      "taxonomy",
      "page",
      "verify",
      "project-index",
      "unlock",
      "event",
      "log",
      "journal-cleanup",
    ]);
    expect(readFileSync(join(vault, "projects/llm-wiki/architecture/example.md"), "utf8")).toBe(draftContent);
    expect(readFileSync(join(vault, "SCHEMA.md"), "utf8")).toContain("topology");
    expect(readFileSync(join(vault, "projects/llm-wiki/knowledge.md"), "utf8")).toContain(
      "projects/llm-wiki/architecture/example",
    );
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(indexBefore);
    expect(readFileSync(join(vault, "log.md"), "utf8")).toContain("skillwiki-project-page-publish:");
    expect(existsSync(lockPath(vault))).toBe(false);
  });

  it("does not roll back a verified page when a later stage fails; retry completes", async () => {
    const vault = makeVault(["adr"]);
    const draftContent = archDraft(["adr", "retry-tag"]);
    const draft = writeDraft(draftContent);
    const journalHome = mkdtempSync(join(tmpdir(), "pp-journal-"));

    const preview = await runProjectPagePublish({
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/retry.md",
      logNote: "retry",
      write: false,
      now: NOW,
      journalHome,
    });
    if (!preview.result.ok) return;
    const token = preview.result.data.approval_token!;
    const input = {
      vault,
      draftPath: draft,
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/retry.md",
      logNote: "retry",
      write: true as const,
      approve: token,
      now: NOW,
      journalHome,
    };

    const failing = defaultProjectPagePublishDeps({
      afterStage: async (stage) => {
        if (stage === "event") throw new Error("injected event failure");
      },
    });
    const failed = await runProjectPagePublish(input, failing);
    expect(failed.result).toMatchObject({
      ok: false,
      detail: { stage: "event", published: true, verified: true, retry_safe: true },
    });
    expect(readFileSync(join(vault, "projects/llm-wiki/architecture/retry.md"), "utf8")).toBe(draftContent);

    // Same approval still valid: prior is now draft bytes, so re-preview.
    const preview2 = await runProjectPagePublish({ ...input, write: false, approve: undefined });
    if (!preview2.result.ok) return;
    const token2 = preview2.result.data.approval_token!;
    const retried = await runProjectPagePublish({ ...input, approve: token2 });
    expect(retried.exitCode).toBe(ExitCode.OK);
    expect(readFileSync(join(vault, "log.md"), "utf8")).toContain("skillwiki-project-page-publish:");
  });

  it("leaves root index byte-identical and refuses path escape targets", async () => {
    const vault = makeVault();
    const indexBefore = readFileSync(join(vault, "index.md"), "utf8");
    const result = await runProjectPagePublish({
      vault,
      draftPath: writeDraft(archDraft()),
      project: "llm-wiki",
      target: "projects/llm-wiki/architecture/../README.md",
      write: false,
      now: NOW,
    });
    expect(result.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(readFileSync(join(vault, "index.md"), "utf8")).toBe(indexBefore);
  });
});
