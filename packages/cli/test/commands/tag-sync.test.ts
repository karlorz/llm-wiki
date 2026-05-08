import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runTagSync } from "../../src/commands/tag-sync.js";

let tmpDir: string;

async function makeVault(pages: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  await writeFile(join(dir, "SCHEMA.md"), "# Vault Schema\n", "utf8");
  await mkdir(join(dir, "entities"), { recursive: true });
  await mkdir(join(dir, "concepts"), { recursive: true });

  for (const [name, content] of Object.entries(pages)) {
    const dirName = join(dir, ...name.split("/").slice(0, -1));
    await mkdir(dirName, { recursive: true });
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

const PAGE_WITH_PROVENANCE = `---
title: Test Page
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [architecture]
sources:
  - "^[raw/test.md]"
provenance: project
---

# Test Page

Content here.
`;

const PAGE_WITH_CONFIDENCE = `---
title: Confidence Page
created: 2026-05-09
updated: 2026-05-09
type: entity
tags: [org]
sources:
  - "^[raw/test.md]"
confidence: high
---

# Confidence Page

Content here.
`;

const PAGE_WITHOUT_ENUMS = `---
title: Plain Page
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [architecture]
sources:
  - "^[raw/test.md]"
---

# Plain Page

Content here.
`;

const PAGE_ALREADY_SYNCED = `---
title: Synced Page
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [architecture, provenance/project]
sources:
  - "^[raw/test.md]"
provenance: project
---

# Synced Page

Content here.
`;

const PAGE_MULTIPLE_ENUMS = `---
title: Multi Enum Page
created: 2026-05-09
updated: 2026-05-09
type: entity
tags: [tooling]
sources:
  - "^[raw/test.md]"
provenance: research
confidence: high
---

# Multi Enum Page

Content here.
`;

describe("runTagSync", () => {
  beforeEach(() => { tmpDir = ""; });

  afterEach(async () => {
    if (tmpDir) {
      await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true }));
    }
  });

  it("mirrors provenance enum values to nested tags", async () => {
    tmpDir = await makeVault({ "concepts/test.md": PAGE_WITH_PROVENANCE });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    if (r.result.ok) {
      expect(r.result.data.synced).toContain("concepts/test.md");
    }
    const content = await readFile(join(tmpDir, "concepts", "test.md"), "utf8");
    expect(content).toContain("provenance/project");
    // Original tag preserved
    expect(content).toContain("architecture");
  });

  it("mirrors confidence enum values to nested tags", async () => {
    tmpDir = await makeVault({ "entities/acme.md": PAGE_WITH_CONFIDENCE });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    if (r.result.ok) {
      expect(r.result.data.synced).toContain("entities/acme.md");
    }
    const content = await readFile(join(tmpDir, "entities", "acme.md"), "utf8");
    expect(content).toContain("confidence/high");
    // Original tag preserved
    expect(content).toContain("org");
  });

  it("handles inline and multi-line tag formats", async () => {
    const inlinePage = `---
title: Inline Tags
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [alpha, beta]
provenance: project
---

# Inline Tags

Content.
`;

    const multilinePage = `---
title: Multi-line Tags
created: 2026-05-09
updated: 2026-05-09
type: concept
tags:
  - gamma
  - delta
provenance: mixed
---

# Multi-line Tags

Content.
`;

    tmpDir = await makeVault({
      "concepts/inline.md": inlinePage,
      "concepts/multiline.md": multilinePage,
    });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.synced).toContain("concepts/inline.md");
      expect(r.result.data.synced).toContain("concepts/multiline.md");
    }

    // Inline file: original tags + nested tag present
    const inlineContent = await readFile(join(tmpDir, "concepts", "inline.md"), "utf8");
    expect(inlineContent).toContain("alpha");
    expect(inlineContent).toContain("beta");
    expect(inlineContent).toContain("provenance/project");

    // Multi-line file: original tags + nested tag present
    const mlContent = await readFile(join(tmpDir, "concepts", "multiline.md"), "utf8");
    expect(mlContent).toContain("gamma");
    expect(mlContent).toContain("delta");
    expect(mlContent).toContain("provenance/mixed");
  });

  it("does not duplicate existing nested tags", async () => {
    tmpDir = await makeVault({ "concepts/synced.md": PAGE_ALREADY_SYNCED });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.synced).not.toContain("concepts/synced.md");
      expect(r.result.data.unchanged).toBeGreaterThanOrEqual(1);
    }

    // Verify the nested tag appears exactly once in the tags list
    const content = await readFile(join(tmpDir, "concepts", "synced.md"), "utf8");
    const tagsMatch = content.match(/tags:\s*\[([^\]]*)\]/);
    expect(tagsMatch).not.toBeNull();
    const tagList = tagsMatch![1]!.split(",").map(t => t.trim());
    const provenanceCount = tagList.filter(t => t === "provenance/project").length;
    expect(provenanceCount).toBe(1);
  });

  it("returns VAULT_PATH_INVALID for missing vault", async () => {
    const r = await runTagSync({ vault: "/nonexistent/path/vault-xxx", dryRun: false });
    expect(r.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
    expect(r.result.ok).toBe(false);
  });

  it("dry-run does not write files", async () => {
    tmpDir = await makeVault({ "concepts/test.md": PAGE_WITH_PROVENANCE });
    const originalContent = await readFile(join(tmpDir, "concepts", "test.md"), "utf8");

    const r = await runTagSync({ vault: tmpDir, dryRun: true });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    if (r.result.ok) {
      expect(r.result.data.synced).toContain("concepts/test.md");
      expect(r.result.data.humanHint).toContain("dry run");
    }

    // File content must be unchanged
    const afterContent = await readFile(join(tmpDir, "concepts", "test.md"), "utf8");
    expect(afterContent).toBe(originalContent);
  });

  it("skips pages without provenance or confidence", async () => {
    tmpDir = await makeVault({ "concepts/plain.md": PAGE_WITHOUT_ENUMS });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    // No pages synced → exit code OK (not MIGRATION_APPLIED)
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.synced).not.toContain("concepts/plain.md");
      expect(r.result.data.unchanged).toBeGreaterThanOrEqual(1);
    }

    // File unchanged — no nested tags added
    const content = await readFile(join(tmpDir, "concepts", "plain.md"), "utf8");
    expect(content).toContain("tags: [architecture]");
    expect(content).not.toContain("provenance/");
    expect(content).not.toContain("confidence/");
  });

  it("adds multiple nested tags for multiple enum fields", async () => {
    tmpDir = await makeVault({ "concepts/multi.md": PAGE_MULTIPLE_ENUMS });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    if (r.result.ok) {
      expect(r.result.data.synced).toContain("concepts/multi.md");
    }
    const content = await readFile(join(tmpDir, "concepts", "multi.md"), "utf8");
    expect(content).toContain("provenance/research");
    expect(content).toContain("confidence/high");
  });

  it("handles multi-line YAML tags between other multi-line fields", async () => {
    const pageWithMultiline = `---
title: Multi-line Test
created: 2026-05-09
updated: 2026-05-09
type: concept
tags:
  - architecture
  - tooling
sources:
  - "^[raw/test1.md]"
  - "^[raw/test2.md]"
provenance: project
---

# Multi-line Test

Content here.
`;
    tmpDir = await makeVault({ "concepts/multi.md": pageWithMultiline });
    const r = await runTagSync({ vault: tmpDir, dryRun: false });
    expect(r.exitCode).toBe(ExitCode.MIGRATION_APPLIED);
    const content = await readFile(join(tmpDir, "concepts", "multi.md"), "utf8");
    expect(content).toContain("provenance/project");
    expect(content).toContain("architecture");
    expect(content).toContain("tooling");
    // sources should NOT be corrupted
    expect(content).toContain("^[raw/test1.md]");
    expect(content).toContain("^[raw/test2.md]");
  });
});
