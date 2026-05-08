import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "@skillwiki/shared";
import { runSeed } from "../../src/commands/seed.js";

let tmpDir: string;

async function makeVault(withSchema = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  if (withSchema) {
    await writeFile(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  }
  await mkdir(join(dir, "entities"), { recursive: true });
  await mkdir(join(dir, "concepts"), { recursive: true });
  await mkdir(join(dir, "raw", "articles"), { recursive: true });
  return dir;
}

describe("runSeed", () => {
  beforeEach(() => { tmpDir = ""; });

  afterEach(async () => {
    if (tmpDir) {
      await import("node:fs/promises").then(fs => fs.rm(tmpDir, { recursive: true, force: true }));
    }
  });

  it("creates example pages in an empty vault", async () => {
    tmpDir = await makeVault();
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.created.length).toBeGreaterThanOrEqual(3);
      expect(r.result.data.skipped.length).toBe(0);
    }
    // Verify files exist
    const entity = await stat(join(tmpDir, "entities", "example-project.md"));
    expect(entity.isFile()).toBe(true);
    const concept = await stat(join(tmpDir, "concepts", "example-concept.md"));
    expect(concept.isFile()).toBe(true);
    const raw = await stat(join(tmpDir, "raw", "articles", "example-source.md"));
    expect(raw.isFile()).toBe(true);
  });

  it("skips pages that already exist", async () => {
    tmpDir = await makeVault();
    // Create entity page first
    await writeFile(join(tmpDir, "entities", "example-project.md"), "existing", "utf8");
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.skipped).toContain("entities/example-project.md");
      expect(r.result.data.created).not.toContain("entities/example-project.md");
    }
    // Existing file should not be overwritten
    const content = await readFile(join(tmpDir, "entities", "example-project.md"), "utf8");
    expect(content).toBe("existing");
  });

  it("returns VAULT_PATH_INVALID if SCHEMA.md missing", async () => {
    tmpDir = await makeVault(false);
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.VAULT_PATH_INVALID);
  });

  it("creates pages with valid frontmatter", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const content = await readFile(join(tmpDir, "entities", "example-project.md"), "utf8");
    expect(content).toContain("title: Example Project");
    expect(content).toContain("type: entity");
    expect(content).toContain("tags: [research]");
  });

  it("seed pages have correct type field for each category", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const entityContent = await readFile(join(tmpDir, "entities", "example-project.md"), "utf8");
    expect(entityContent).toContain("type: entity");
    expect(entityContent).not.toContain("type: concept");
    const conceptContent = await readFile(join(tmpDir, "concepts", "example-concept.md"), "utf8");
    expect(conceptContent).toContain("type: concept");
    expect(conceptContent).not.toContain("type: entity");
  });

  it("raw source page has valid sha256 in frontmatter", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const rawContent = await readFile(join(tmpDir, "raw", "articles", "example-source.md"), "utf8");
    // Verify sha256 frontmatter field exists and is a 64-char hex string
    const sha256Match = rawContent.match(/^sha256:\s*([0-9a-f]{64})\s*$/m);
    expect(sha256Match).not.toBeNull();
    expect(sha256Match![1]).toHaveLength(64);
    // Also verify other required raw frontmatter fields
    expect(rawContent).toContain("source_url:");
    expect(rawContent).toContain("ingested:");
  });

  it("returns empty created and no next-steps hint when all pages already exist", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.created).toEqual([]);
      expect(r.result.data.skipped.length).toBeGreaterThanOrEqual(3);
      expect(r.result.data.humanHint).not.toContain("next steps");
    }
  });

  it("skips only pre-existing raw page while creating typed-knowledge pages", async () => {
    tmpDir = await makeVault();
    await mkdir(join(tmpDir, "raw", "articles"), { recursive: true });
    await writeFile(join(tmpDir, "raw", "articles", "example-source.md"), "existing-raw", "utf8");
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.skipped).toContain("raw/articles/example-source.md");
      expect(r.result.data.created).toContain("entities/example-project.md");
      expect(r.result.data.created).toContain("concepts/example-concept.md");
      const rawContent = await readFile(join(tmpDir, "raw", "articles", "example-source.md"), "utf8");
      expect(rawContent).toBe("existing-raw");
    }
  });

  it("humanHint includes next steps when at least one page is created", async () => {
    tmpDir = await makeVault();
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("next steps");
      expect(r.result.data.humanHint).toContain("seeded:");
      expect(r.result.data.humanHint).toContain("skipped (already exist):");
    }
  });

  it("creates entity page with aliases frontmatter", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const content = await readFile(join(tmpDir, "entities", "example-project.md"), "utf8");
    expect(content).toContain("aliases: [example-project]");
  });

  it("creates concept page with Related section linking to entity", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const content = await readFile(join(tmpDir, "concepts", "example-concept.md"), "utf8");
    expect(content).toContain("[[example-project]]");
    expect(content).toContain("## Related");
  });

  it("raw source page contains immutability notice", async () => {
    tmpDir = await makeVault();
    await runSeed({ vault: tmpDir });
    const content = await readFile(join(tmpDir, "raw", "articles", "example-source.md"), "utf8");
    expect(content).toContain("never edit");
  });

  it("created + skipped counts equal total example pages", async () => {
    tmpDir = await makeVault();
    const r = await runSeed({ vault: tmpDir });
    expect(r.exitCode).toBe(ExitCode.OK);
    if (r.result.ok) {
      const total = r.result.data.created.length + r.result.data.skipped.length;
      // 3 example pages: entities/example-project.md, concepts/example-concept.md, raw/articles/example-source.md
      expect(total).toBe(3);
    }
  });
});
