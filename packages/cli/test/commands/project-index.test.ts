import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProjectIndex } from "../../src/commands/project-index.js";

const CONCEPT_FM = (slug: string, title: string) => `---
title: ${title}
created: 2026-05-08
updated: 2026-05-08
type: concept
tags: [test]
sources: [raw/test.md]
provenance: project
provenance_projects: ["[[${slug}]]"]
---

# ${title}

Some content.
`;

function makeVault(slug: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "projects", slug), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  mkdirSync(join(dir, "entities"), { recursive: true });
  return dir;
}

describe("runProjectIndex", () => {
  it("returns PROJECT_NOT_FOUND for missing project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
    mkdirSync(join(dir, "projects"), { recursive: true });
    const r = await runProjectIndex({ vault: dir, slug: "no-such-project", apply: false });
    expect(r.exitCode).toBe(37);
    expect(r.result.ok).toBe(false);
  });

  it("finds concept pages referencing the project", async () => {
    const dir = makeVault("cmux");
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));
    writeFileSync(join(dir, "concepts", "cmux-plugins.md"), CONCEPT_FM("cmux", "Plugin System"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries.length).toBe(2);
      expect(r.result.data.entries[0].type).toBe("concept");
    }
  });

  it("excludes pages not referencing the project", async () => {
    const dir = makeVault("cmux");
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));
    writeFileSync(join(dir, "concepts", "other-project.md"), CONCEPT_FM("other", "Other Thing"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries.length).toBe(1);
    }
  });

  it("writes knowledge.md with --apply", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: true });
    expect(r.exitCode).toBe(0);

    const knowledge = readFileSync(join(dir, "projects", "cmux", "knowledge.md"), "utf8");
    expect(knowledge).toContain("Routing Design");
    expect(knowledge).toContain("[[concepts/cmux-routing]]");
  });

  it("detects stale existing index", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "knowledge.md"), "# old index\n");
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.existing).toBe(true);
      expect(r.result.data.stale).toBe(true);
    }
  });

  it("returns empty entries when no pages reference the project", async () => {
    const dir = makeVault("empty-proj");

    const r = await runProjectIndex({ vault: dir, slug: "empty-proj", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries.length).toBe(0);
    }
  });
});
