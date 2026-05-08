import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runCompound, runCompoundList, runCompoundDelete } from "../../src/commands/compound.js";

const LOG_NO_RETROS = `# Log

## [2026-05-04] action | something happened

- detail

`;

const LOG_SINGLE_YES = `# Log

## [2026-05-04] retro | loop cycle: test-cycle

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes (applies to all vaults)
- ClaudeMd?:      no
- WorkflowShift?: no

`;

const LOG_SINGLE_NO = `# Log

## [2026-05-04] retro | loop cycle: skip-cycle

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    no
- ClaudeMd?:      no
- WorkflowShift?: no

`;

const LOG_MIXED = `# Log

## [2026-05-04] retro | loop cycle: yes-cycle

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes (applies broadly)
- ClaudeMd?:      no
- WorkflowShift?: no

## [2026-05-04] action | normal entry

- detail

## [2026-05-04] retro | loop cycle: no-cycle

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    no
- ClaudeMd?:      no
- WorkflowShift?: no

## [2026-05-05] retro | loop cycle: another-yes

- Friction:       Another friction
- Miss:           Another miss
- Improve:        Another improvement
- Generalize?:    yes (universal pattern)
- ClaudeMd?:      no
- WorkflowShift?: no

`;

let tmpDir: string;

async function makeVault(logContent?: string, withCompoundDir = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  await writeFile(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  if (logContent !== undefined) {
    await writeFile(join(dir, "log.md"), logContent);
  }
  if (withCompoundDir) {
    await mkdir(join(dir, "projects", "test-proj", "compound"), { recursive: true });
  } else {
    await mkdir(join(dir, "projects", "test-proj"), { recursive: true });
  }
  return dir;
}

describe("runCompoundPromote", () => {
  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) {
      await import("node:fs/promises").then((fs) =>
        fs.rm(tmpDir, { recursive: true, force: true })
      );
    }
  });

  it("returns FILE_NOT_FOUND (2) when log.md is missing", async () => {
    tmpDir = await makeVault(); // no log.md
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
    expect(r.result.ok).toBe(false);
  });

  it("returns OK (0) when log.md has no retro entries", async () => {
    tmpDir = await makeVault(LOG_NO_RETROS);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(0);
      expect(r.result.data.promoted).toEqual([]);
    }
  });

  it("skips retro where Generalize?: no", async () => {
    tmpDir = await makeVault(LOG_SINGLE_NO);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.promoted).toEqual([]);
      expect(r.result.data.skipped).toEqual(["2026-05-04"]);
    }
  });

  it("promotes retro where Generalize?: yes with correct frontmatter", async () => {
    tmpDir = await makeVault(LOG_SINGLE_YES);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39); // COMPOUND_PROMOTED
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.promoted).toEqual(["test-cycle.md"]);
    }
    // Verify the compound file was created with proper frontmatter
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    const compoundFile = files.find((f) => f.includes("test-cycle"));
    expect(compoundFile).toBeDefined();
    const content = await readFile(join(compoundDir, compoundFile!), "utf8");
    expect(content).toContain("---");
    expect(content).toContain("type: pattern");
    expect(content).toContain('project: "[[test-proj]]"');
    expect(content).toContain("Should do better");
    expect(content).toContain("Something broke");
  });

  it("is idempotent — running twice produces no duplicates", async () => {
    tmpDir = await makeVault(LOG_SINGLE_YES);
    const r1 = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r1.exitCode).toBe(39);
    const r2 = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r2.exitCode).toBe(ExitCode.OK);
    if (r2.result.ok) {
      expect(r2.result.data.promoted).toEqual([]);
    }
    // Only one compound file should exist
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    const matching = files.filter((f) => f.includes("test-cycle"));
    expect(matching).toHaveLength(1);
  });

  it("promotes only yes-retros from mixed entries", async () => {
    tmpDir = await makeVault(LOG_MIXED);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(3);
      expect(r.result.data.promoted).toEqual(["yes-cycle.md", "another-yes.md"]);
      expect(r.result.data.skipped).toEqual(["2026-05-04"]);
    }
  });

  it("dry run reports promotions without creating files", async () => {
    tmpDir = await makeVault(LOG_SINGLE_YES);
    const r = await runCompound({
      vault: tmpDir,
      project: "test-proj",
      dryRun: true,
    });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["test-cycle.md"]);
    }
    // No compound file should have been created
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    expect(files).toHaveLength(0);
  });

  it("creates compound/ directory if it does not exist", async () => {
    tmpDir = await makeVault(LOG_SINGLE_YES, false); // no compound dir
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    expect(existsSync(compoundDir)).toBe(false);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    expect(existsSync(compoundDir)).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["test-cycle.md"]);
    }
  });

  it("handles retro with cycle number and infers gotcha type from bug/error friction", async () => {
    const logWithCycleNum = `# Log

## [2026-05-06] retro | loop cycle 7: ci-fixup

- Friction:       bug in CI pipeline caused flaky error
- Miss:           Missed the race condition
- Improve:        Add retry logic
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logWithCycleNum);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39); // COMPOUND_PROMOTED
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.promoted).toEqual(["ci-fixup.md"]);
    }
    // Verify type is "gotcha" (friction contains "bug" and "error")
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    const compoundFile = files.find((f) => f.includes("ci-fixup"));
    expect(compoundFile).toBeDefined();
    const content = await readFile(join(compoundDir, compoundFile!), "utf8");
    expect(content).toContain("type: gotcha");
  });

  it("infers lesson type as default when improve lacks 'should' and friction lacks 'bug'/'error'", async () => {
    const logLesson = `# Log

## [2026-05-07] retro | loop cycle: deploy-check

- Friction:       Deploy took too long
- Miss:           Did not pre-warm
- Improve:        Pre-warm infrastructure
- Generalize?:    yes (applies to all deploys)
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logLesson);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["deploy-check.md"]);
    }
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    const compoundFile = files.find((f) => f.includes("deploy-check"));
    expect(compoundFile).toBeDefined();
    const content = await readFile(join(compoundDir, compoundFile!), "utf8");
    expect(content).toContain("type: lesson");
  });

  it("returns OK with zero scanned when log.md is empty", async () => {
    tmpDir = await makeVault("");
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(0);
      expect(r.result.data.promoted).toEqual([]);
      expect(r.result.data.skipped).toEqual([]);
    }
  });

  // --- Malformed retro entries ---

  it("promotes retro with missing Friction and Improve fields using empty strings", async () => {
    const logMissingFields = `# Log

## [2026-05-08] retro | loop cycle: missing-fields

- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logMissingFields);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39); // COMPOUND_PROMOTED
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.promoted).toEqual(["missing-fields.md"]);
    }
    // Verify the compound file: type should be "lesson" (no "should" or "bug"/"error")
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "missing-fields.md"), "utf8");
    expect(content).toContain("type: lesson");
    // Body sections should exist even with empty values
    expect(content).toContain("## Lesson");
    expect(content).toContain("## Evidence");
    expect(content).toContain("## Source");
  });

  it("handles retro with empty Friction/Improve values (whitespace-only)", async () => {
    const logEmptyVals = `# Log

## [2026-05-08] retro | loop cycle: empty-vals

- Friction:
- Miss:           Something missed
- Improve:
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logEmptyVals);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39); // COMPOUND_PROMOTED
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.promoted).toEqual(["empty-vals.md"]);
    }
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "empty-vals.md"), "utf8");
    expect(content).toContain("type: lesson");
  });

  it("captures only the first line of multiline field values", async () => {
    const logMultiline = `# Log

## [2026-05-08] retro | loop cycle: multiline-vals

- Friction:       First friction line
  second friction line
- Miss:           Something missed
- Improve:        First improve line
  second improve line
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logMultiline);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["multiline-vals.md"]);
    }
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "multiline-vals.md"), "utf8");
    // Only first lines should appear in the compound body
    expect(content).toContain("First friction line");
    expect(content).toContain("First improve line");
    // Second lines should NOT appear (regex captures one line only)
    expect(content).not.toContain("second friction line");
    expect(content).not.toContain("second improve line");
  });

  it("skips retro heading with no field body", async () => {
    const logNoBody = `# Log

## [2026-05-08] retro | loop cycle: empty-retro

## [2026-05-08] action | something else

- detail

`;
    tmpDir = await makeVault(logNoBody);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(0);
      expect(r.result.data.promoted).toEqual([]);
    }
  });

  // --- Unicode / special characters in cycle names ---

  it("slugifies cycle names with Unicode characters", async () => {
    const logUnicode = `# Log

## [2026-05-08] retro | loop cycle: résumé review

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logUnicode);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["r-sum-review.md"]);
    }
    // Verify file was created with the slugified name
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "r-sum-review.md"), "utf8");
    expect(content).toContain("title: résumé review");
  });

  it("slugifies cycle names with special characters", async () => {
    const logSpecial = `# Log

## [2026-05-08] retro | loop cycle: fix: bug #123

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logSpecial);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.promoted).toEqual(["fix-bug-123.md"]);
    }
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "fix-bug-123.md"), "utf8");
    expect(content).toContain("title: fix: bug #123");
  });

  it("handles very long cycle names without truncation", async () => {
    const longName = "a".repeat(200);
    const logLong = `# Log

## [2026-05-08] retro | loop cycle: ${longName}

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logLong);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      // slugify does not truncate; the slug is all "a"s
      expect(r.result.data.promoted).toEqual([`${longName}.md`]);
    }
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const files = await readdir(compoundDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${longName}.md`);
  });

  it("includes humanHint with scanned, promoted, and skipped counts", async () => {
    tmpDir = await makeVault(LOG_MIXED);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("scanned: 3");
      expect(r.result.data.humanHint).toContain("promoted: 2");
      expect(r.result.data.humanHint).toContain("skipped (Generalize?: no): 1");
    }
  });

  it("sets confidence to medium in promoted compound files", async () => {
    tmpDir = await makeVault(LOG_SINGLE_YES);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "test-cycle.md"), "utf8");
    expect(content).toContain("confidence: medium");
  });

  it("extracts tags from Generalize? parenthetical content", async () => {
    const logWithTags = `# Log

## [2026-05-08] retro | loop cycle: tagged-compound

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes (drift detection)
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logWithTags);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "tagged-compound.md"), "utf8");
    expect(content).toContain("tags: [drift, detection]");
  });

  it("defaults to dev-loop tag when no parenthetical in Generalize", async () => {
    const logNoParens = `# Log

## [2026-05-08] retro | loop cycle: no-parens

- Friction:       Something broke
- Miss:           Something missed
- Improve:        Should do better
- Generalize?:    yes
- ClaudeMd?:      no
- WorkflowShift?: no

`;
    tmpDir = await makeVault(logNoParens);
    const r = await runCompound({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(39);
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    const content = await readFile(join(compoundDir, "no-parens.md"), "utf8");
    expect(content).toContain("tags: [dev-loop]");
  });
});

describe("runCompoundList", () => {
  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) {
      await import("node:fs/promises").then((fs) =>
        fs.rm(tmpDir, { recursive: true, force: true })
      );
    }
  });

  it("returns OK with empty entries when compound directory does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    await mkdir(join(tmpDir, "projects", "test-proj"), { recursive: true });

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.project).toBe("test-proj");
      expect(r.result.data.entries).toEqual([]);
    }
  });

  it("returns OK with empty entries when compound directory is empty", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    await mkdir(join(tmpDir, "projects", "test-proj", "compound"), { recursive: true });

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.project).toBe("test-proj");
      expect(r.result.data.entries).toEqual([]);
    }
  });

  it("lists compound entries with frontmatter fields", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "test-pattern.md"), [
      "---",
      "title: Test Pattern",
      "created: '2026-05-04'",
      "updated: '2026-05-04'",
      "type: pattern",
      "tags: [drift, dev-loop]",
      "confidence: medium",
      'project: "[[test-proj]]"',
      "work_items: []",
      "---",
      "## Pattern",
      "",
      "Some pattern description",
    ].join("\n"), "utf8");

    await writeFile(join(compoundDir, "another-gotcha.md"), [
      "---",
      "title: Another Gotcha",
      "created: '2026-05-05'",
      "updated: '2026-05-05'",
      "type: gotcha",
      "tags: [config]",
      "confidence: high",
      'project: "[[test-proj]]"',
      "work_items: []",
      "---",
      "## Gotcha",
      "",
      "Some gotcha description",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.project).toBe("test-proj");
      expect(r.result.data.entries).toHaveLength(2);

      const pattern = r.result.data.entries.find(e => e.file === "test-pattern.md");
      expect(pattern).toBeDefined();
      expect(pattern!.title).toBe("Test Pattern");
      expect(pattern!.type).toBe("pattern");
      expect(pattern!.created).toBe("2026-05-04");
      expect(pattern!.tags).toEqual(["drift", "dev-loop"]);

      const gotcha = r.result.data.entries.find(e => e.file === "another-gotcha.md");
      expect(gotcha).toBeDefined();
      expect(gotcha!.title).toBe("Another Gotcha");
      expect(gotcha!.type).toBe("gotcha");
      expect(gotcha!.created).toBe("2026-05-05");
      expect(gotcha!.tags).toEqual(["config"]);
    }
  });

  it("skips non-markdown files in compound directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "notes.txt"), "not a markdown file");
    await writeFile(join(compoundDir, "valid.md"), [
      "---",
      "title: Valid Entry",
      "type: lesson",
      "created: '2026-05-01'",
      "tags: []",
      "---",
      "Content",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.entries).toHaveLength(1);
      expect(r.result.data.entries[0]!.file).toBe("valid.md");
    }
  });

  it("handles compound files with missing frontmatter fields using defaults", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "minimal.md"), [
      "---",
      "",
      "---",
      "Just a body with empty frontmatter",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.entries).toHaveLength(1);
      const entry = r.result.data.entries[0]!;
      expect(entry.file).toBe("minimal.md");
      expect(entry.title).toBe("minimal"); // falls back to filename without .md
      expect(entry.type).toBe("lesson"); // default type
      expect(entry.created).toBe(""); // no created field
      expect(entry.tags).toEqual([]); // no tags
    }
  });

  // --- Corrupted frontmatter ---

  it("skips compound files with invalid YAML frontmatter", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    // Invalid YAML: unclosed bracket
    await writeFile(join(compoundDir, "broken-yaml.md"), [
      "---",
      "title: Broken YAML",
      "type: pattern",
      "tags: [drift",
      "invalid yaml here",
      "---",
      "Some content",
    ].join("\n"), "utf8");

    // A valid file alongside the broken one
    await writeFile(join(compoundDir, "valid.md"), [
      "---",
      "title: Valid Entry",
      "type: lesson",
      "created: '2026-05-01'",
      "tags: []",
      "---",
      "Content",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      // Only the valid file should appear; broken-yaml is skipped
      expect(r.result.data.entries).toHaveLength(1);
      expect(r.result.data.entries[0]!.file).toBe("valid.md");
    }
  });

  it("lists compound files missing the work_items field", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "no-work-items.md"), [
      "---",
      "title: No Work Items",
      "type: pattern",
      "created: '2026-05-04'",
      "tags: [drift]",
      "---",
      "Content without work_items field",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.entries).toHaveLength(1);
      const entry = r.result.data.entries[0]!;
      expect(entry.file).toBe("no-work-items.md");
      expect(entry.title).toBe("No Work Items");
      expect(entry.type).toBe("pattern");
      expect(entry.created).toBe("2026-05-04");
    }
  });

  it("lists compound files with non-array work_items field", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "bad-work-items.md"), [
      "---",
      "title: Bad Work Items",
      "type: gotcha",
      "created: '2026-05-04'",
      "tags: [config]",
      "work_items: not-an-array",
      "---",
      "Content with string work_items",
    ].join("\n"), "utf8");

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.entries).toHaveLength(1);
      const entry = r.result.data.entries[0]!;
      expect(entry.file).toBe("bad-work-items.md");
      expect(entry.title).toBe("Bad Work Items");
      expect(entry.type).toBe("gotcha");
    }
  });

  // --- Empty vault ---

  it("returns OK with empty entries when vault has no projects directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    // No projects/ directory at all

    const r = await runCompoundList({ vault: tmpDir, project: "test-proj" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.project).toBe("test-proj");
      expect(r.result.data.entries).toEqual([]);
    }
  });
});

describe("runCompoundDelete", () => {
  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) {
      await import("node:fs/promises").then((fs) =>
        fs.rm(tmpDir, { recursive: true, force: true })
      );
    }
  });

  it("deletes a compound entry and regenerates knowledge.md", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "to-delete.md"), [
      "---",
      "title: To Delete",
      "created: '2026-05-04'",
      "updated: '2026-05-04'",
      "type: pattern",
      "tags: [test]",
      "confidence: medium",
      'project: "[[test-proj]]"',
      "work_items: []",
      "---",
      "## Pattern",
      "",
      "Some pattern description",
    ].join("\n"), "utf8");

    // Create a pre-existing knowledge.md
    await writeFile(join(tmpDir, "projects", "test-proj", "knowledge.md"), "# old index\n", "utf8");

    const r = await runCompoundDelete({ vault: tmpDir, project: "test-proj", entry: "to-delete" });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.deleted).toContain("to-delete.md");
      expect(r.result.data.project).toBe("test-proj");
    }

    // File should no longer exist
    expect(existsSync(join(compoundDir, "to-delete.md"))).toBe(false);

    // knowledge.md should be regenerated (not the old content)
    const knowledge = await readFile(join(tmpDir, "projects", "test-proj", "knowledge.md"), "utf8");
    expect(knowledge).not.toBe("# old index\n");
    expect(knowledge).toContain("Knowledge Index");
  });

  it("returns FILE_NOT_FOUND when compound entry does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    const r = await runCompoundDelete({ vault: tmpDir, project: "test-proj", entry: "nonexistent" });
    expect(r.exitCode).toBe(ExitCode.FILE_NOT_FOUND);
    expect(r.result.ok).toBe(false);
  });

  it("returns PROJECT_NOT_FOUND when project does not exist", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");

    const r = await runCompoundDelete({ vault: tmpDir, project: "no-such-proj", entry: "some-entry" });
    expect(r.exitCode).toBe(ExitCode.PROJECT_NOT_FOUND);
    expect(r.result.ok).toBe(false);
  });

  it("handles entry name with .md suffix by normalizing it", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vault-"));
    await writeFile(join(tmpDir, "SCHEMA.md"), "# Vault Schema\n");
    const compoundDir = join(tmpDir, "projects", "test-proj", "compound");
    await mkdir(compoundDir, { recursive: true });

    await writeFile(join(compoundDir, "suffix-test.md"), [
      "---",
      "title: Suffix Test",
      "created: '2026-05-04'",
      "updated: '2026-05-04'",
      "type: lesson",
      "tags: []",
      'project: "[[test-proj]]"',
      "work_items: []",
      "---",
      "Content",
    ].join("\n"), "utf8");

    // Pass entry name WITH .md suffix
    const r = await runCompoundDelete({ vault: tmpDir, project: "test-proj", entry: "suffix-test.md" });
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(existsSync(join(compoundDir, "suffix-test.md"))).toBe(false);
  });
});
