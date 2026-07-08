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

  it("includes compound pages in the index", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "compound", "routing-gotcha.md"), `---
title: Routing Gotcha
type: gotcha
project: "[[cmux]]"
created: 2026-05-09
updated: 2026-05-09
---

# Routing Gotcha

Watch out for trailing slashes.
`);
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries.length).toBe(2);
      const gotcha = r.result.data.entries.find(e => e.type === "gotcha");
      expect(gotcha).toBeDefined();
      expect(gotcha!.page).toBe("projects/cmux/compound/routing-gotcha.md");
      expect(gotcha!.title).toBe("Routing Gotcha");
    }
  });

  it("writes compound entries to knowledge.md with --apply", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "compound", "routing-pattern.md"), `---
title: Routing Pattern
type: pattern
project: "[[cmux]]"
created: 2026-05-09
updated: 2026-05-09
---

# Routing Pattern

Use hub pages.
`);
    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: true });
    expect(r.exitCode).toBe(0);

    const knowledge = readFileSync(join(dir, "projects", "cmux", "knowledge.md"), "utf8");
    expect(knowledge).toContain("pattern");
    expect(knowledge).toContain("Routing Pattern");
    expect(knowledge).toContain("[[projects/cmux/compound/routing-pattern]]");
  });

  it("includes project-local requirement pages in knowledge.md", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "requirements"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "requirements", "routing-implementation.md"), `---
title: Routing Implementation Report
type: reference
created: 2026-05-10
updated: 2026-05-10
provenance: project
provenance_projects: ["[[cmux]]"]
---

# Routing Implementation Report

Done.
`);

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: true });
    expect(r.exitCode).toBe(0);

    const knowledge = readFileSync(join(dir, "projects", "cmux", "knowledge.md"), "utf8");
    expect(knowledge).toContain("## requirement");
    expect(knowledge).toContain("[[projects/cmux/requirements/routing-implementation]] — Routing Implementation Report");
  });

  it("includes project work spec pages in knowledge.md", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "work", "2026-05-10-routing"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "work", "2026-05-10-routing", "spec.md"), `---
title: Routing Work Spec
kind: spec
status: done
project: "[[cmux]]"
created: 2026-05-10
provenance: project
---

# Routing Work Spec

Build it.
`);

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: true });
    expect(r.exitCode).toBe(0);

    const knowledge = readFileSync(join(dir, "projects", "cmux", "knowledge.md"), "utf8");
    expect(knowledge).toContain("## spec");
    expect(knowledge).toContain("[[projects/cmux/work/2026-05-10-routing/spec]] — Routing Work Spec");
  });

  it("finds entity pages referencing the project", async () => {
    const dir = makeVault("cmux");
    writeFileSync(join(dir, "entities", "cmux-router.md"), `---
title: CMUX Router
created: 2026-05-08
updated: 2026-05-08
type: entity
tags: [test]
sources: [raw/test.md]
provenance: project
provenance_projects: ["[[cmux]]"]
---

# CMUX Router

Entity description.
`);
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));

    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // Entities sort before concepts
      expect(r.result.data.entries.length).toBe(2);
      expect(r.result.data.entries[0].type).toBe("entity");
      expect(r.result.data.entries[0].page).toBe("entities/cmux-router.md");
      expect(r.result.data.entries[1].type).toBe("concept");
    }
  });

  it("reports existing index as up-to-date (not stale)", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "concepts", "cmux-routing.md"), CONCEPT_FM("cmux", "Routing Design"));
    // First apply to create knowledge.md
    await runProjectIndex({ vault: dir, slug: "cmux", apply: true });
    // Second run should detect existing and NOT stale
    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.existing).toBe(true);
      expect(r.result.data.stale).toBe(false);
    }
  });

  it("defaults compound type to 'compound' when type missing from frontmatter", async () => {
    const dir = makeVault("cmux");
    mkdirSync(join(dir, "projects", "cmux", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "cmux", "compound", "no-type.md"), `---
title: No Type Entry
project: "[[cmux]]"
created: 2026-05-09
updated: 2026-05-09
---

# No Type Entry

Body text.
`);
    const r = await runProjectIndex({ vault: dir, slug: "cmux", apply: false });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.entries.length).toBe(1);
      expect(r.result.data.entries[0].type).toBe("compound");
      expect(r.result.data.entries[0].title).toBe("No Type Entry");
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
