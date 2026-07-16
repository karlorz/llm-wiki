import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexCheck } from "../../src/commands/index-check.js";
import { renderRootIndex } from "../../src/utils/index-projection.js";

function v(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  for (const d of ["entities", "concepts", "comparisons", "queries"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const FM = `---
title: t
type: concept
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

describe("runIndexCheck", () => {
  it("clean: every file is in the index, every index entry resolves", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[alpha]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
  });

  it("missing from index -> exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toContain("concepts/alpha.md");
    }
  });

  it("ghost entry (index points to nonexistent slug) -> exit 18", async () => {
    const dir = v();
    writeFileSync(join(dir, "index.md"), `# Index\n\n## Concepts\n- [[ghost]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.ghost_entries).toContain("ghost");
    }
  });

  it("compound pages are not flagged as missing_from_index", async () => {
    const dir = v();
    mkdirSync(join(dir, "projects", "myproj", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "myproj", "compound", "lesson-learned.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toHaveLength(0);
    }
  });

  it("compound page in index.md is not a ghost entry", async () => {
    const dir = v();
    mkdirSync(join(dir, "projects", "myproj", "compound"), { recursive: true });
    writeFileSync(join(dir, "projects", "myproj", "compound", "lesson-learned.md"), FM);
    writeFileSync(join(dir, "index.md"), `# Index\n\n- [[projects/myproj/compound/lesson-learned]] — a lesson\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.ghost_entries).toHaveLength(0);
    }
  });

  it("matches index entries case-insensitively", async () => {
    const dir = v();
    writeFileSync(join(dir, "entities", "c929.md"), `---
title: C929
created: 2026-01-01
updated: 2026-01-01
type: entity
tags: []
sources: [raw/articles/seed.md]
---

# C929
`);
    writeFileSync(join(dir, "index.md"), "# Index\n\n- [[C929]] — widebody\n");
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toHaveLength(0);
      expect(r.result.data.ghost_entries).toHaveLength(0);
    }
  });

  it("same basename in different typed dirs requires path-qualified index links", async () => {
    const dir = v();
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "entities", "alpha.md"), `---
title: Alpha Entity
type: entity
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`);
    // Basename-only link is ambiguous and must not cover both pages.
    writeFileSync(join(dir, "index.md"), `# Index\n\n- [[alpha]]\n`);
    const r = await runIndexCheck({ vault: dir });
    expect(r.exitCode).toBe(18);
    if (r.result.ok) {
      expect(r.result.data.missing_from_index).toEqual(
        expect.arrayContaining(["concepts/alpha.md", "entities/alpha.md"]),
      );
    }

    writeFileSync(
      join(dir, "index.md"),
      `# Index\n\n- [[concepts/alpha]]\n- [[entities/alpha]]\n`,
    );
    const r2 = await runIndexCheck({ vault: dir });
    expect(r2.exitCode).toBe(0);
  });

  it("accepts the canonical renderer output for valid pages and project READMEs", async () => {
    const dir = v();
    mkdirSync(join(dir, "meta"), { recursive: true });
    mkdirSync(join(dir, "projects", "demo", "compound"), { recursive: true });
    writeFileSync(join(dir, "concepts", "alpha.md"), FM);
    writeFileSync(join(dir, "concepts", "shared.md"), FM.replace("title: t", "title: Shared Concept"));
    writeFileSync(join(dir, "entities", "shared.md"), `---
title: Shared Entity
type: entity
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`);
    writeFileSync(join(dir, "meta", "shared-meta.md"), `---
title: Shared Meta Page
type: meta
tags: []
provenance: mixed
provenance_projects: ["[[alpha]]", "[[beta]]"]
created: 2026-05-03
updated: 2026-05-03
---

`);
    writeFileSync(join(dir, "concepts", "invalid-yaml.md"), "---\ntitle: [broken\n---\n");
    writeFileSync(join(dir, "concepts", "wrong-directory.md"), `---
title: Wrong Directory
type: entity
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`);
    writeFileSync(join(dir, "projects", "demo", "README.md"), "# Project: Demo Project\n");
    writeFileSync(join(dir, "projects", "demo", "compound", "lesson.md"), "# Lesson\n");

    const projection = await renderRootIndex({ vault: dir });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    writeFileSync(join(dir, "index.md"), projection.data.text);

    const checked = await runIndexCheck({ vault: dir });
    expect(checked.exitCode).toBe(0);
    if (!checked.result.ok) return;
    expect(checked.result.data.missing_from_index).not.toEqual(
      expect.arrayContaining(["concepts/invalid-yaml.md", "concepts/wrong-directory.md"]),
    );
    expect(checked.result.data.ghost_entries).not.toContain("projects/demo/README");
    expect(projection.data.entries.map((entry) => entry.target)).toEqual(
      expect.arrayContaining(["meta/shared-meta", "concepts/shared", "entities/shared"]),
    );
  });
});
