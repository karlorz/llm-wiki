import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaim } from "../../src/commands/claim.js";

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(v, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(v, "projects"), { recursive: true });
  return v;
}

describe("runClaim", () => {
  it("creates work item from transcript with frontmatter project", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-foo.md"), `---
source_url:
ingested: 2026-04-01
kind: task
project: "[[acme]]"
---

Fix the foo thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-foo.md" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.workItemPath).toBe("projects/acme/work/2026-04-01-fix-foo");
      expect(r.result.data.specPath).toBe("projects/acme/work/2026-04-01-fix-foo/spec.md");
      expect(r.result.data.source).toBe("raw/transcripts/2026-04-01-task-fix-foo.md");
    }
    // Verify spec.md was created with source: field
    const spec = readFileSync(join(v, "projects", "acme", "work", "2026-04-01-fix-foo", "spec.md"), "utf8");
    expect(spec).toContain("source: raw/transcripts/2026-04-01-task-fix-foo.md");
    expect(spec).toContain("status: planned");
    expect(spec).toContain("kind: task");
  });

  it("uses --project override when frontmatter has no project", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-bar.md"), `---
source_url:
ingested: 2026-04-01
kind: task
---

Fix the bar thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-bar.md", project: "acme" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.workItemPath).toBe("projects/acme/work/2026-04-01-fix-bar");
    }
  });

  it("uses --slug override for work item name", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-foo.md"), `---
source_url:
ingested: 2026-04-01
kind: task
project: "[[acme]]"
---

Fix the foo thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-foo.md", slug: "foo-hotfix" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.workItemPath).toBe("projects/acme/work/2026-04-01-foo-hotfix");
    }
  });

  it("errors when no project is available", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-foo.md"), `---
source_url:
ingested: 2026-04-01
kind: task
---

Fix the foo thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-foo.md" });
    expect(r.exitCode).toBe(4); // SCHEME_REJECTED
  });

  it("errors when project directory does not exist", async () => {
    const v = makeVault();
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-foo.md"), `---
source_url:
ingested: 2026-04-01
kind: task
project: "[[nonexistent]]"
---

Fix the foo thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-foo.md" });
    expect(r.exitCode).toBe(37); // PROJECT_NOT_FOUND
  });

  it("errors when transcript does not exist", async () => {
    const v = makeVault();
    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-nonexistent.md" });
    expect(r.exitCode).toBe(2); // FILE_NOT_FOUND
  });

  it("returns ok when work item already exists", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work", "2026-04-01-fix-foo"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-task-fix-foo.md"), `---
source_url:
ingested: 2026-04-01
kind: task
project: "[[acme]]"
---

Fix the foo thing.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-task-fix-foo.md" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("already exists");
    }
  });

  it("strips kind prefix from slug derivation", async () => {
    const v = makeVault();
    mkdirSync(join(v, "projects", "acme", "work"), { recursive: true });
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-bug-crash-on-startup.md"), `---
source_url:
ingested: 2026-04-01
kind: bug
project: "[[acme]]"
---

App crashes.`);

    const r = await runClaim({ vault: v, transcript: "raw/transcripts/2026-04-01-bug-crash-on-startup.md" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.workItemPath).toBe("projects/acme/work/2026-04-01-crash-on-startup");
    }
  });
});
