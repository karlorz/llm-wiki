import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../../src/commands/lint.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
  - architecture
\`\`\`
`;

const FM = (tags: string[], updated = "2026-05-03") => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: ${updated}
updated: ${updated}
---

`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) mkdirSync(join(v, d), { recursive: true });
  return v;
}

describe("runLint", () => {
  it("clean fixture exits 0", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "> **TL;DR:** Summary about alpha.\n\n## Overview\n\nContent about alpha [[alpha]].\n\n## Details\n\nMore details here.\n\n## Related\n\n- [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBe(0);
      expect(r.result.data.summary.warnings).toBe(0);
      expect(r.result.data.summary.info).toBe(0);
    }
  });

  it("warning-only fixture exits 22 (LINT_HAS_WARNINGS)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      expect(r.result.data.summary.warnings).toBeGreaterThan(0);
      expect(r.result.data.summary.errors).toBe(0);
    }
  });

  it("error fixture exits 23 (LINT_HAS_ERRORS)", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["rogue"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      expect(r.result.data.summary.errors).toBeGreaterThan(0);
      const kinds = r.result.data.by_severity.error.map(e => e.kind);
      expect(kinds).toContain("tag_not_in_taxonomy");
    }
  });

  it("returns vault path + source in the envelope", async () => {
    const v = vault();
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      expect(r.result.data.vault.path).toBe(v);
      expect(r.result.data.vault.source).toBe("resolved");
    }
  });

  it("does not produce topic_map_recommended for small vaults", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body [[alpha]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("topic_map_recommended");
    }
  });

  it("warns on legacy citation style pages", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Body cites X.\n^[raw/articles/x.md]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("legacy_citation_style");
    }
  });

  it("warns on orphaned citations after Sources section", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    // Citation marker after blank line in Sources section = orphaned
    const body = "Body cites X. ^[raw/articles/x.md]\n\n## Sources\n- ^[raw/articles/x.md]\n\n\n^[raw/articles/x.md]\n";
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("orphaned_citations");
    }
  });

  it("flags thin pages missing structural sections as page_structure", async () => {
    const v = vault();
    // Page with no Overview, no Related, only 1 section — under 60 lines
    writeFileSync(join(v, "concepts", "thin.md"), FM(["model"]) + "Just a short body.\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[thin]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22); // info counts as LINT_HAS_WARNINGS
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).toContain("page_structure");
    }
  });

  it("accepts ## Relationships as alias for ## Related", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nContent.\n\n## Details\n\nMore.\n\n## Relationships\n\n- [[beta]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("page_structure");
    }
  });

  it("warns on duplicate frontmatter blocks", async () => {
    const v = vault();
    // Page with two frontmatter blocks (e.g., from a bad edit that prepended a new block)
    const dup = `---
title: first
type: concept
tags: [model]
---
title: second
type: concept
tags: [model]
---

## Overview

Content.
`;
    writeFileSync(join(v, "concepts", "dup.md"), dup);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[dup]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("duplicate_frontmatter");
    }
  });

  it("warns on missing_overview for pages without ## Overview", async () => {
    const v = vault();
    // Page with sections but no Overview — over 60 body lines so it's not a page_structure duplicate
    const body = Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n\nContent for section ${i + 1}.\n`).join("\n");
    writeFileSync(join(v, "concepts", "no-overview.md"), FM(["model"]) + body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[no-overview]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("missing_overview");
    }
  });

  it("does not flag missing_overview for pages with ## Overview", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "has-overview.md"), FM(["model"]) + "## Overview\n\nContent.\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[has-overview]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("missing_overview");
    }
  });

  it("warns on orphan pages with no wikilinks", async () => {
    const v = vault();
    // orphan.md has no wikilinks at all → isolated node in the graph
    writeFileSync(join(v, "concepts", "orphan.md"), FM(["model"]) + "## Overview\n\nNo wikilinks at all.\n\n## Details\n\nJust content.\n\n## Related\n\nNo links.\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[orphan]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("orphans");
    }
  });

  it("flags broken wikilinks in frontmatter as frontmatter_wikilink", async () => {
    const v = vault();
    const fm = `---
title: t
type: concept
tags: [model]
sources: []
provenance: project
provenance_projects: ["[[nonexistent]]"]
created: 2026-05-07
updated: 2026-05-07
---

## Overview

Content.

## Related

- [[alpha]]
`;
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nContent about alpha [[alpha]].\n\n## Details\n\nMore details here.\n\n## Related\n\n- [[alpha]]\n");
    writeFileSync(join(v, "concepts", "badfm.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n- [[badfm]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22); // info counts as LINT_HAS_WARNINGS
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).toContain("frontmatter_wikilink");
      const fmBucket = r.result.data.by_severity.info.find(b => b.kind === "frontmatter_wikilink");
      expect(fmBucket!.items.length).toBe(1);
      expect(fmBucket!.items[0]).toContain("nonexistent");
    }
  });

  it("does not flag valid wikilinks in frontmatter", async () => {
    const v = vault();
    const fm = (proj: string) => `---
title: t
type: concept
tags: [model]
sources: []
provenance: project
provenance_projects: ["[[${proj}]]"]
created: 2026-05-07
updated: 2026-05-07
---

## Overview

Content.

## Related

- [[${proj}]]
`;
    writeFileSync(join(v, "concepts", "alpha.md"), fm("alpha"));
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("frontmatter_wikilink");
    }
  });

  it("flags broken_sources when sources: entry points to non-existent raw file", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/missing.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

## Overview

Content.

## Related

- [[x]]
`;
    writeFileSync(join(v, "concepts", "badsrc.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[badsrc]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
      expect(errorKinds).toContain("broken_sources");
      const bucket = r.result.data.by_severity.error.find(b => b.kind === "broken_sources");
      expect(bucket!.items.length).toBe(1);
      expect(bucket!.items[0]).toContain("raw/articles/missing.md");
    }
  });

  it("flags broken_sources with inline sources array format", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "concepts", "inlinesrc.md"), FM(["model"]).replace("sources: []", "sources: [raw/articles/gone.md]") + "## Overview\n\nContent.\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[inlinesrc]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(23);
    if (r.result.ok) {
      const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
      expect(errorKinds).toContain("broken_sources");
    }
  });

  it("does not flag broken_sources when sources: entry resolves to existing raw file", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

## Overview

Content.

## Related

- [[x]]
`;
    writeFileSync(join(v, "concepts", "goodsrc.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[goodsrc]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
      expect(errorKinds).not.toContain("broken_sources");
    }
  });

  it("does not flag broken_sources when source entry omits .md extension but file exists", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    // File exists as raw/articles/x.md but sources entry omits .md
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

## Overview

Content.

## Related

- [[x]]
`;
    writeFileSync(join(v, "concepts", "noext.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[noext]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
      expect(errorKinds).not.toContain("broken_sources");
    }
  });

  it("warns on work item with spec but no plan after 24h", async () => {
    const v = vault();
    const workDir = join(v, "projects", "test", "work", "2026-05-01-stale-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: Stale item
status: open
created: 2026-05-01
---

## Overview

A stale work item.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("work_item_health");
      const bucket = r.result.data.by_severity.warning.find(b => b.kind === "work_item_health");
      expect(bucket!.items.length).toBe(1);
      expect(bucket!.items[0]).toContain("has spec but no plan after 24h");
    }
  });

  it("does not warn on work item with spec and plan", async () => {
    const v = vault();
    const workDir = join(v, "projects", "test", "work", "2026-05-01-complete-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: Complete item
status: open
created: 2026-05-01
---

## Overview

A work item with a plan.
`);
    writeFileSync(join(workDir, "plan.md"), `---
title: Complete item plan
created: 2026-05-02
---

## Plan

Do the work.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("work_item_health");
    }
  });

  it("warns on work item with in-progress status but no started date", async () => {
    const v = vault();
    const workDir = join(v, "projects", "test", "work", "2026-05-08-no-start");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: No start date
status: in-progress
created: 2026-05-08
---

## Overview

An item in progress without a started date.
`);
    writeFileSync(join(workDir, "plan.md"), `---
title: No start date plan
created: 2026-05-08
---

## Plan

Do the work.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("work_item_health");
      const bucket = r.result.data.by_severity.warning.find(b => b.kind === "work_item_health");
      expect(bucket!.items.some(i => String(i).includes("in-progress without started date"))).toBe(true);
    }
  });

  it("does not warn on in-progress work item with started date", async () => {
    const v = vault();
    const today = new Date().toISOString().slice(0, 10);
    const workDir = join(v, "projects", "test", "work", `${today}-has-start`);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: Has start date
status: in-progress
started: ${today}
created: ${today}
---

## Overview

An item in progress with a started date.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("work_item_health");
    }
  });

  it("does not warn on completed work item without plan after 24h", async () => {
    const v = vault();
    const workDir = join(v, "projects", "test", "work", "2026-05-01-done-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: Done item
status: completed
created: 2026-05-01
---

## Overview

A completed work item with no separate plan.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("work_item_health");
    }
  });

  it("does not warn on abandoned work item without plan after 24h", async () => {
    const v = vault();
    const workDir = join(v, "projects", "test", "work", "2026-05-01-dropped-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---
title: Dropped item
status: abandoned
created: 2026-05-01
---

## Overview

An abandoned work item.
`);
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("work_item_health");
    }
  });

  it("flags orphaned_project_pages when page claims project but knowledge.md omits it", async () => {
    const v = vault();
    mkdirSync(join(v, "projects", "test-proj"), { recursive: true });
    // knowledge.md exists but does not reference concepts/orphaned.md
    writeFileSync(join(v, "projects", "test-proj", "knowledge.md"), "# Knowledge Index: test-proj\n\nNo entries.\n");
    const fm = `---
title: Orphaned Page
type: concept
tags: [model]
sources: []
provenance: project
provenance_projects: ["[[test-proj]]"]
created: 2026-05-08
updated: 2026-05-08
---

## Overview

An orphaned page.
`;
    writeFileSync(join(v, "concepts", "orphaned.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[orphaned]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).toContain("orphaned_project_pages");
      const bucket = r.result.data.by_severity.warning.find(b => b.kind === "orphaned_project_pages");
      expect(bucket!.items.length).toBe(1);
      expect(bucket!.items[0]).toBe("concepts/orphaned.md: not in projects/test-proj/knowledge.md");
    }
  });

  it("does not flag orphaned_project_pages when knowledge.md lists the page", async () => {
    const v = vault();
    mkdirSync(join(v, "projects", "test-proj"), { recursive: true });
    writeFileSync(join(v, "projects", "test-proj", "knowledge.md"), "# Knowledge Index: test-proj\n\n## concept\n\n- [[concepts/linked]] — Linked Page\n");
    const fm = `---
title: Linked Page
type: concept
tags: [model]
sources: []
provenance: project
provenance_projects: ["[[test-proj]]"]
created: 2026-05-08
updated: 2026-05-08
---

## Overview

A properly linked page.
`;
    writeFileSync(join(v, "concepts", "linked.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[linked]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("orphaned_project_pages");
    }
  });

  it("does not flag orphaned_project_pages when project has no knowledge.md", async () => {
    const v = vault();
    mkdirSync(join(v, "projects", "no-index"), { recursive: true });
    // No knowledge.md created — not an orphan, just not indexed yet
    const fm = `---
title: Unindexed Page
type: concept
tags: [model]
sources: []
provenance: project
provenance_projects: ["[[no-index]]"]
created: 2026-05-08
updated: 2026-05-08
---

## Overview

Not yet indexed.
`;
    writeFileSync(join(v, "concepts", "unindexed.md"), fm);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[unindexed]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warningKinds).not.toContain("orphaned_project_pages");
    }
  });

  it("flags [[raw/...]] wikilinks as wikilink_citation", async () => {
    const v = vault();
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nCites source [[raw/articles/x.md]].\n\n## Related\n\n- [[beta]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).toContain("wikilink_citation");
      const bucket = r.result.data.by_severity.info.find(b => b.kind === "wikilink_citation");
      expect(bucket!.items.length).toBe(1);
    }
  });

  it("does not flag ^[raw/...] citations as wikilink_citation", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "## Overview\n\nCites source. ^[raw/articles/x.md]\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[beta]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("wikilink_citation");
    }
  });

  it("flags missing_tldr for pages without ## TL;DR", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "no-tldr.md"), fm + "## Overview\n\nContent.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[no-tldr]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).toContain("missing_tldr");
      const bucket = r.result.data.by_severity.info.find(b => b.kind === "missing_tldr");
      expect(bucket!.items).toContain("concepts/no-tldr.md");
    }
  });

  it("does not flag missing_tldr for pages with blockquote TL;DR", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "has-tldr.md"), fm + "> **TL;DR:** Summary here.\n\n## Overview\n\nContent.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[has-tldr]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("missing_tldr");
    }
  });

  it("does not flag missing_tldr for pages with ## TL;DR heading", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "has-tldr.md"), fm + "## TL;DR\n\n- Summary here.\n\n## Overview\n\nContent.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[has-tldr]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("missing_tldr");
    }
  });

  it("fixes missing_tldr by inserting ## TL;DR stub after frontmatter", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "no-tldr.md"), fm + "## Overview\n\nContent.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[no-tldr]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
    if (r.result.ok) {
      expect(r.result.data.fixed).toContain("concepts/no-tldr.md");
    }
    // Re-lint — should no longer flag missing_tldr
    const r2 = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r2.result.ok) {
      const infoKinds = r2.result.data.by_severity.info.map(b => b.kind);
      expect(infoKinds).not.toContain("missing_tldr");
    }
    // File should have > **TL;DR:** stub after the title heading
    const content = require("fs").readFileSync(join(v, "concepts", "no-tldr.md"), "utf8");
    expect(content).toContain("> **TL;DR:** ");
  });

  it("flags missing_diagram for architecture-tagged pages without mermaid", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [architecture]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "arch.md"), fm + "## TL;DR\n\n- Summary.\n\n## Overview\n\nArchitecture content without diagrams.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[arch]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    expect(r.exitCode).toBe(22);
    if (r.result.ok) {
      const warnKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warnKinds).toContain("missing_diagram");
      const bucket = r.result.data.by_severity.warning.find(b => b.kind === "missing_diagram");
      expect(bucket!.items).toContain("concepts/arch.md");
    }
  });

  it("does not flag missing_diagram for architecture pages with mermaid", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [architecture]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    const body = "## TL;DR\n\n- Summary.\n\n## Overview\n\nArchitecture with diagram.\n\n```mermaid\ngraph TB\n  A --> B\n```\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n";
    writeFileSync(join(v, "concepts", "arch.md"), fm + body);
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[arch]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warnKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warnKinds).not.toContain("missing_diagram");
    }
  });

  it("does not flag missing_diagram for non-architecture pages", async () => {
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "x.md"), "Raw content");
    const fm = `---
title: t
type: concept
tags: [model]
sources:
  - "^[raw/articles/x.md]"
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;
    writeFileSync(join(v, "concepts", "concept.md"), fm + "## TL;DR\n\n- Summary.\n\n## Overview\n\nConcept without diagram — fine because no architecture tag.\n\n## Sources\n\n- ^[raw/articles/x.md]\n\n## Related\n\n- [[x]]\n");
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[concept]]\n");
    const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
    if (r.result.ok) {
      const warnKinds = r.result.data.by_severity.warning.map(b => b.kind);
      expect(warnKinds).not.toContain("missing_diagram");
    }
  });

  describe("--fix", () => {
    it("fixes legacy_citation_style by moving inline markers to ## Sources", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      const body = "Some claim about X. ^[raw/articles/x.md]\nAnother claim. ^[raw/articles/y.md]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
        expect(r.result.data.unresolved).toHaveLength(0);
      }
      // Re-lint without fix — should no longer flag legacy_citation_style
      const r2 = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r2.result.ok) {
        const warningKinds = r2.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).not.toContain("legacy_citation_style");
      }
      // File should now have ## Sources section
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("## Sources");
      expect(content).toContain("- ^[raw/articles/x.md]");
      expect(content).toContain("- ^[raw/articles/y.md]");
      // Inline markers should be removed from body
      expect(content).not.toMatch(/Some claim about X\.\s*\^\[raw/);
      expect(content).not.toMatch(/Another claim\.\s*\^\[raw/);
    });

    it("appends to existing ## Sources section", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      // Inline marker on its own line (not at paragraph end) triggers legacy_citation_style
      // even with an existing ## Sources section
      const body = "Some claim about X.\n^[raw/articles/x.md]\n\n## Sources\n\n- ^[raw/articles/y.md]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
      }
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("- ^[raw/articles/y.md]");
      expect(content).toContain("- ^[raw/articles/x.md]");
    });

    it("removes all occurrences of the same marker across multiple body lines", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      // Same marker repeated across 3 paragraphs — was only removing first occurrence
      const body =
        "First claim. ^[raw/articles/x.md]\n\n" +
        "Second claim. ^[raw/articles/x.md]\n\n" +
        "Third claim. ^[raw/articles/x.md]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
        expect(r.result.data.unresolved).toHaveLength(0);
      }
      // Re-lint — should NOT flag legacy_citation_style
      const r2 = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r2.result.ok) {
        const warningKinds = r2.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).not.toContain("legacy_citation_style");
      }
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      // All inline markers should be removed from body
      expect(content).not.toMatch(/claim\.\s*\^\[raw/);
      // Marker should appear exactly once in ## Sources (deduped)
      const sourcesSection = content.split("## Sources")[1];
      const markerMatches = sourcesSection.match(/\^\[raw\/articles\/x\.md\]/g);
      expect(markerMatches).toHaveLength(1);
    });

    it("fixes missing_overview by inserting ## Overview stub after frontmatter", async () => {
      const v = vault();
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + "Just a body with no overview.\n");
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
      }
      // Re-lint without fix — should no longer flag missing_overview
      const r2 = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r2.result.ok) {
        const warningKinds = r2.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).not.toContain("missing_overview");
      }
      // File should now have ## Overview after frontmatter
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("## Overview\n\nt\n\nJust a body with no overview.");
    });

    it("fixes missing_overview using title from frontmatter", async () => {
      const v = vault();
      const fm = `---
title: My Special Title
type: concept
tags: [model]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

Some body text.
`;
      writeFileSync(join(v, "concepts", "titled.md"), fm);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[titled]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/titled.md");
      }
      const content = require("fs").readFileSync(join(v, "concepts", "titled.md"), "utf8");
      expect(content).toContain("## Overview\n\nMy Special Title\n\nSome body text.");
    });

    it("fixes wikilink_citation by adding citations to existing ## Sources section", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      writeFileSync(join(v, "raw", "articles", "y.md"), "Raw content");
      const body = "## Overview\n\nCites source [[raw/articles/x.md]].\n\n## Sources\n\n- ^[raw/articles/y.md]\n\n## Related\n\n- [[beta]]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
      }
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("- ^[raw/articles/y.md]");
      expect(content).toContain("- ^[raw/articles/x.md]");
      expect(content).not.toContain("[[raw/");
    });

    it("fixes wikilink_citation by creating ## Sources section when missing", async () => {
      const v = vault();
      const body = "## Overview\n\nCites source [[raw/articles/x.md]].\n\n## Related\n\n- [[beta]]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain("concepts/alpha.md");
      }
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("## Sources");
      expect(content).toContain("- ^[raw/articles/x.md]");
      expect(content).not.toContain("[[raw/");
    });

    it("does not modify files when fix is not set", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      const body = "Some claim about X. ^[raw/articles/x.md]\n";
      writeFileSync(join(v, "concepts", "alpha.md"), FM(["model"]) + body);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        expect(r.result.data.fixed).toHaveLength(0);
      }
      // File should be unchanged
      const content = require("fs").readFileSync(join(v, "concepts", "alpha.md"), "utf8");
      expect(content).toContain("Some claim about X. ^[raw/articles/x.md]");
    });

    it("warns on raw files in subdirectory duplicating flat-space content", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles", "obsidian-migration"), { recursive: true });

      // Flat canonical file
      writeFileSync(join(v, "raw", "articles", "export-obsidian-foo.md"), `---
type: raw
sha256: ${"a".repeat(64)}
ingested: "2026-05-19"
---

Article body content for foo.
`);

      // Subdirectory file with same stem (different content — subdirectory detection is stem-based)
      writeFileSync(join(v, "raw", "articles", "obsidian-migration", "export-obsidian-foo.md"), `---
type: raw
sha256: ${"b".repeat(64)}
ingested: "2026-05-19"
---

Different content, same filename stem.
`);

      writeFileSync(join(v, "concepts", "test.md"), FM(["model"]) + "## TL;DR\n\n- Test.\n\n## Overview\n\nBody.\n");
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[test]]\n");

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      expect(r.exitCode).toBe(22);
      if (r.result.ok) {
        const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).toContain("raw_subdirectory_duplicate");
      }
    });

    it("keeps raw subdirectory duplicate checks scoped by raw type", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles", "import"), { recursive: true });
      mkdirSync(join(v, "raw", "papers", "import"), { recursive: true });

      writeFileSync(join(v, "raw", "articles", "shared.md"), `---
type: raw
sha256: ${"a".repeat(64)}
ingested: "2026-05-19"
---

Article flat body.
`);
      writeFileSync(join(v, "raw", "papers", "shared.md"), `---
type: raw
sha256: ${"b".repeat(64)}
ingested: "2026-05-19"
---

Paper flat body.
`);
      writeFileSync(join(v, "raw", "articles", "import", "shared.md"), `---
type: raw
sha256: ${"c".repeat(64)}
ingested: "2026-05-19"
---

Article nested body.
`);
      writeFileSync(join(v, "raw", "papers", "import", "shared.md"), `---
type: raw
sha256: ${"d".repeat(64)}
ingested: "2026-05-19"
---

Paper nested body.
`);

      writeFileSync(join(v, "concepts", "test.md"), FM(["model"]) + "## TL;DR\n\n- Test.\n\n## Overview\n\nBody.\n");
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[test]]\n");

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      expect(r.exitCode).toBe(22);
      if (r.result.ok) {
        const bucket = r.result.data.by_severity.warning.find(b => b.kind === "raw_subdirectory_duplicate");
        expect(bucket!.items).toContain("raw/articles/import/shared.md -> duplicate of raw/articles/shared.md");
        expect(bucket!.items).toContain("raw/papers/import/shared.md -> duplicate of raw/papers/shared.md");
      }
    });

    it("warns on body duplicates with different frontmatter SHA256", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });

      writeFileSync(join(v, "raw", "articles", "a.md"), `---
type: raw
sha256: ${"a".repeat(64)}
ingested: "2026-05-19"
---

same body content here
`);
      writeFileSync(join(v, "raw", "articles", "b.md"), `---
type: raw
sha256: ${"b".repeat(64)}
ingested: "2026-05-19"
---

same body content here
`);

      writeFileSync(join(v, "concepts", "test.md"), FM(["model"]) + "## TL;DR\n\n- Test.\n\n## Overview\n\nBody.\n");
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[test]]\n");

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      expect(r.exitCode).toBe(22);
      if (r.result.ok) {
        const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).toContain("raw_body_duplicate");
      }
    });
  });

  describe("--only", () => {
    it("filters to a single bucket", async () => {
      const v = vault();
      writeFileSync(join(v, "concepts", "test.md"), FM(["model"]) + "# Test\n\n> **TL;DR:** test\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "bridges" });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        const allKinds = [
          ...r.result.data.by_severity.error,
          ...r.result.data.by_severity.warning,
          ...r.result.data.by_severity.info,
        ].map(b => b.kind);
        // Only "bridges" should appear (if it has items), no other buckets
        for (const k of allKinds) {
          expect(k).toBe("bridges");
        }
      }
    });

    it("returns UNKNOWN_BUCKET for invalid bucket name", async () => {
      const v = vault();
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "nonexistent" });
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) {
        expect(r.result.error).toBe("UNKNOWN_BUCKET");
      }
    });

    it("returns empty results for bucket with no violations", async () => {
      const v = vault();
      writeFileSync(join(v, "concepts", "test.md"), FM(["model"]) + "# Test\n\n> **TL;DR:** test\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cli_refs" });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.summary.info).toBe(0);
      }
    });

    it("ignores cli_refs violations in raw pages (immutable historical scope)", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "transcripts"), { recursive: true });
      writeFileSync(
        join(v, "raw", "transcripts", "2026-05-30-idea-legacy-cli.md"),
        `---\nsource_url: null\ningested: 2026-05-30\nkind: idea\n---\n\nLegacy note: \`skillwiki sync peers\`.\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cli_refs" });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.summary.info).toBe(0);
      }
    });

    it("still reports cli_refs violations in typed knowledge pages", async () => {
      const v = vault();
      writeFileSync(
        join(v, "concepts", "bad-cli-ref.md"),
        FM(["model"]) + "## TL;DR\n\n- test\n\n## Overview\n\nRun `skillwiki log-append`.\n"
      );
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[bad-cli-ref]]\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "cli_refs" });
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.summary.info).toBeGreaterThan(0);
        const infoKinds = r.result.data.by_severity.info.map(b => b.kind);
        expect(infoKinds).toContain("cli_refs");
      }
    });
  });

  describe("stale_sections", () => {
    it("reports stale_sections info when expiry annotations are expired", async () => {
      const v = vault();
      const pastDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      writeFileSync(
        join(v, "concepts", "expired-section.md"),
        FM(["model"]) + `## Stats\n<!-- expires: ${pastDate} -->\nOld data\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const sections = r.result.data.by_severity.info.filter((i: any) => i.kind === "stale_sections");
        expect(sections.length).toBeGreaterThanOrEqual(1);
        expect(sections[0]!.items[0]).toContain("expired");
      }
    });

    it("reports approaching expiry within 7 days", async () => {
      const v = vault();
      const soonDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      writeFileSync(
        join(v, "concepts", "approaching-section.md"),
        FM(["model"]) + `## Stats\n<!-- expires: ${soonDate} -->\nAlmost expired\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const sections = r.result.data.by_severity.info.filter((i: any) => i.kind === "stale_sections");
        expect(sections.length).toBeGreaterThanOrEqual(1);
        expect(sections[0]!.items[0]).toContain("expires in");
      }
    });

    it("does not report unexpired sections beyond 7 days", async () => {
      const v = vault();
      const futureDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      writeFileSync(
        join(v, "concepts", "future-section.md"),
        FM(["model"]) + `## Stats\n<!-- expires: ${futureDate} -->\nStill valid\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const sections = r.result.data.by_severity.info.filter((i: any) => i.kind === "stale_sections");
        expect(sections).toHaveLength(0);
      }
    });

    it("supports --only stale_sections", async () => {
      const v = vault();
      const pastDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      writeFileSync(
        join(v, "concepts", "only-section.md"),
        FM(["model"]) + `## Stats\n<!-- expires: ${pastDate} -->\nOld\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "stale_sections" });
      if (r.result.ok) {
        expect(r.result.data.summary.info).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("file_source_url bucket", () => {
    it("flags raw files with source_url: file://", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      writeFileSync(
        join(v, "raw", "articles", "local-file.md"),
        `---\nsource_url: file:///Users/me/Downloads/article.html\ningested: "2026-05-24"\nsha256: abc123\n---\n\ncontent\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).toContain("file_source_url");
        const bucket = r.result.data.by_severity.warning.find(b => b.kind === "file_source_url");
        expect(bucket?.items).toContain("raw/articles/local-file.md");
      }
    });

    it("does not flag raw files with valid HTTP source_url", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      writeFileSync(
        join(v, "raw", "articles", "web-file.md"),
        `---\nsource_url: https://example.com/article\ningested: "2026-05-24"\nsha256: abc123\n---\n\ncontent\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).not.toContain("file_source_url");
      }
    });

    it("--fix extracts web URL from body source: field and rewrites frontmatter", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      const path = join(v, "raw", "articles", "fixable.md");
      writeFileSync(
        path,
        `---\nsource_url: file:///Users/me/Downloads/article.html\ningested: "2026-05-24"\nsha256: abc123\n---\n\nsource: https://example.com/real-url\n\nbody content\n`
      );
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      expect(r.result.ok).toBe(true);
      const after = readFileSync(path, "utf8");
      expect(after).toContain("source_url: https://example.com/real-url");
      expect(after).not.toContain("source_url: file://");
      // Re-lint: file_source_url should no longer fire
      const r2 = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r2.result.ok) {
        const warningKinds = r2.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).not.toContain("file_source_url");
      }
    });

    it("--fix leaves frontmatter alone when body has no web source: field", async () => {
      const v = vault();
      mkdirSync(join(v, "raw", "articles"), { recursive: true });
      const path = join(v, "raw", "articles", "unfixable.md");
      const before = `---\nsource_url: file:///Users/me/Downloads/x.html\ningested: "2026-05-24"\nsha256: abc123\n---\n\nbody with no source field\n`;
      writeFileSync(path, before);
      await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      const after = readFileSync(path, "utf8");
      expect(after).toBe(before); // unchanged
      // Bucket still flags it
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const warningKinds = r.result.data.by_severity.warning.map(b => b.kind);
        expect(warningKinds).toContain("file_source_url");
      }
    });
  });

  describe("path_too_long", () => {
    it("detects files with paths exceeding 240 chars", async () => {
      const v = vault();
      // concepts/ = 9 chars, .md = 3 chars → need name ≥ 229 chars for path > 240
      const longName = "a".repeat(229) + ".md"; // 9 + 229 + 3 = 241 chars
      const relPath = `concepts/${longName}`;
      const absPath = join(v, relPath);
      mkdirSync(join(v, "concepts"), { recursive: true });
      writeFileSync(absPath, FM(["model"]) + "> **TL;DR:** body.\n\n## Overview\n\nContent.\n");
      writeFileSync(join(v, "index.md"), `# Index\n\n## Concepts\n- [[${longName.replace(".md", "")}]]\n`);

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        expect(r.result.data.summary.errors).toBeGreaterThan(0);
        const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
        expect(errorKinds).toContain("path_too_long");
      }
    });

    it("does not flag paths at exactly 240 chars", async () => {
      const v = vault();
      const prefixLen = "concepts/".length;
      const nameLen = 240 - prefixLen - 3; // -3 for .md
      const name = "b".repeat(nameLen);
      const relPath = `concepts/${name}.md`;
      expect(relPath.length).toBe(240);

      const absPath = join(v, relPath);
      mkdirSync(join(v, "concepts"), { recursive: true });
      writeFileSync(absPath, FM(["model"]) + "> **TL;DR:** body.\n\n## Overview\n\nContent.\n");
      writeFileSync(join(v, "index.md"), `# Index\n\n## Concepts\n- [[${name}]]\n`);

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
        expect(errorKinds).not.toContain("path_too_long");
      }
    });

    it("does not flag short paths", async () => {
      const v = vault();
      writeFileSync(join(v, "concepts", "short.md"), FM(["model"]) + "body\n");
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500 });
      if (r.result.ok) {
        const errorKinds = r.result.data.by_severity.error.map(b => b.kind);
        expect(errorKinds).not.toContain("path_too_long");
      }
    });

    it("--fix truncates filename and rewires citations", async () => {
      const v = vault();
      // concepts/ = 9, .md = 3 → need name ≥ 229 for path > 240
      const longName = "x".repeat(229) + ".md"; // 9 + 229 + 3 = 241 chars
      const relPath = `concepts/${longName}`;
      const absPath = join(v, relPath);
      mkdirSync(join(v, "concepts"), { recursive: true });
      // Lint-clean page body to avoid residual warnings after fix
      const cleanBody = "> **TL;DR:** Long path content.\n\n## Overview\n\nLong path content.\n\n## Details\n\nMore details here.\n\n## Related\n\n- [[citing]]\n";
      writeFileSync(absPath, FM(["model"]) + cleanBody);

      // Create a page that cites the long-path file
      const citingContent = FM(["model"]) + `> **TL;DR:** ref.\n\n## Overview\n\nRef page.\n\n## Details\n\nSee ^[${relPath}] and [[${relPath}|the page]].\n\n## Related\n\n- [[citing]]\n`;
      writeFileSync(join(v, "concepts", "citing.md"), citingContent);
      writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[citing]]\n");

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, fix: true });
      if (r.result.ok) {
        expect(r.result.data.fixed).toContain(relPath);
        // path_too_long error should be gone
        const errKinds = r.result.data.by_severity.error.map(b => b.kind);
        expect(errKinds).not.toContain("path_too_long");
      }

      // Verify citing page was rewired
      const citingAfter = readFileSync(join(v, "concepts", "citing.md"), "utf8");
      expect(citingAfter).not.toContain(relPath);
      // Should contain the truncated path
      expect(citingAfter).toMatch(/\^\[concepts\/x+-\w{8}\.md\]/);
      expect(citingAfter).toMatch(/\[\[concepts\/x+-\w{8}\.md\|the page\]\]/);
    });

    it("--only path_too_long filters correctly", async () => {
      const v = vault();
      const longName = "y".repeat(229) + ".md"; // 9 + 229 + 3 = 241 chars
      const relPath = `concepts/${longName}`;
      const absPath = join(v, relPath);
      mkdirSync(join(v, "concepts"), { recursive: true });
      writeFileSync(absPath, FM(["model"]) + "body\n");
      writeFileSync(join(v, "index.md"), "# Index\n");

      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "path_too_long" });
      expect(r.exitCode).toBe(23);
      if (r.result.ok) {
        expect(r.result.data.by_severity.error.length).toBe(1);
        expect(r.result.data.by_severity.error[0]!.kind).toBe("path_too_long");
        expect(r.result.data.by_severity.warning.length).toBe(0);
        expect(r.result.data.by_severity.info.length).toBe(0);
      }
    });

    it("--only rejects unknown bucket", async () => {
      const v = vault();
      const r = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "nonexistent_bucket" });
      expect(r.exitCode).toBe(46); // USAGE
      if (!r.result.ok) {
        expect(r.result.error).toBe("UNKNOWN_BUCKET");
      }
    });
  });
});
