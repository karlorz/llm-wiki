import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRootIndexUniverse } from "../../src/utils/index-universe.js";

function typedPage(title: string, type: "entity" | "concept"): string {
  return `---
title: ${title}
type: ${type}
tags: []
sources: [raw/articles/seed.md]
provenance: research
created: 2026-07-16
updated: 2026-07-16
---

# ${title}
`;
}

const META_PAGE = `---
title: Shared Meta Page
type: meta
tags: []
provenance: mixed
provenance_projects: ["[[alpha]]", "[[beta]]"]
created: 2026-07-16
updated: 2026-07-16
---

# Shared Meta Page
`;

function makeUniverseVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "index-universe-"));
  writeFileSync(join(vault, "SCHEMA.md"), "# Vault Schema\n");
  writeFileSync(join(vault, "index.md"), "# Vault Index\n");
  for (const dir of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, dir), { recursive: true });
  }
  mkdirSync(join(vault, "projects", "demo", "compound"), { recursive: true });

  writeFileSync(join(vault, "concepts", "valid.md"), typedPage("Valid Concept", "concept"));
  writeFileSync(join(vault, "concepts", "shared.md"), typedPage("Shared Concept", "concept"));
  writeFileSync(join(vault, "entities", "shared.md"), typedPage("Shared Entity", "entity"));
  writeFileSync(join(vault, "meta", "shared-meta.md"), META_PAGE);
  writeFileSync(join(vault, "concepts", "invalid-yaml.md"), "---\ntitle: [broken\n---\n\n# Broken\n");
  writeFileSync(join(vault, "concepts", "wrong-directory.md"), typedPage("Wrong Directory", "entity"));
  writeFileSync(join(vault, "projects", "demo", "README.md"), "# Project: Demo Project\n");
  writeFileSync(join(vault, "projects", "demo", "compound", "lesson.md"), "# Lesson\n");
  return vault;
}

describe("buildRootIndexUniverse", () => {
  it("separates required entries, compatibility targets, and rejected typed pages", async () => {
    const vault = makeUniverseVault();
    const result = await buildRootIndexUniverse({ vault });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.required.map((entry) => entry.target)).toEqual([
      "entities/shared",
      "concepts/shared",
      "concepts/valid",
      "meta/shared-meta",
      "projects/demo/README",
    ]);
    expect([...result.data.knownTargets]).toEqual(expect.arrayContaining([
      "entities/shared",
      "concepts/shared",
      "projects/demo/README",
      "projects/demo/compound/lesson",
    ]));
    expect(result.data.rejectedTyped.map((page) => page.relPath)).toEqual([
      "concepts/invalid-yaml.md",
      "concepts/wrong-directory.md",
    ]);
    expect(result.data.rejectedTyped.map((page) => page.error)).toEqual([
      "INVALID_FRONTMATTER",
      "SCHEME_REJECTED",
    ]);
  });
});
