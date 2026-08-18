import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ExitCode } from "@skillwiki/shared";
import { runEval } from "../../src/commands/eval.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
  - architecture
\`\`\`
`;

const FM = (tags: string[], sources: string[] = ["fixture:seed"], updated = "2026-05-03") => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: [${sources.map((s) => JSON.stringify(s)).join(", ")}]
provenance: research
created: ${updated}
updated: ${updated}
---

`;

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-eval-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("skillwiki eval", () => {
  it("fixture vault with known lint findings matches runner counts", async () => {
    const v = makeVault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "doc1.md"), "# Doc 1\n");

    // page 1: valid citation via frontmatter, but bad tag (1 error: tag_not_in_taxonomy)
    writeFileSync(
      join(v, "concepts", "alpha.md"),
      FM(["rogue"], ["raw/articles/doc1.md"]) +
        "> **TL;DR:** Summary alpha.\n\n## Overview\n\nContent alpha [[alpha]].\n\n## Related\n\n- [[alpha]]\n"
    );
    // page 2: valid citation via ^[raw/...], no overview (1 warning/error depending on rule)
    writeFileSync(
      join(v, "concepts", "beta.md"),
      FM(["model"], []) + "Some content ^[raw/articles/doc1.md].\n"
    );
    // page 3: clean page
    writeFileSync(
      join(v, "concepts", "gamma.md"),
      FM(["model"], ["raw/articles/doc1.md"]) +
        "> **TL;DR:** Summary gamma.\n\n## Overview\n\nContent gamma [[gamma]].\n\n## Related\n\n- [[gamma]]\n"
    );
    writeFileSync(
      join(v, "index.md"),
      "# Index\n\n## Concepts\n- [[alpha]]\n- [[beta]]\n- [[gamma]]\n"
    );

    const res = await runEval({ vault: v });
    expect(res.exitCode).toBe(ExitCode.OK);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) throw new Error("Expected ok");

    const data = res.result.data;
    expect(data.pages_scanned).toBe(7); // SCHEMA.md, index.md, log.md, raw/articles/doc1.md, concepts/alpha.md, concepts/beta.md, concepts/gamma.md
    expect(data.findings_total).toBeGreaterThan(0);
    expect(data.findings_by_severity.error + data.findings_by_severity.warning + data.findings_by_severity.info).toBe(
      data.findings_total
    );
    expect(data.citation_coverage.total_typed_pages).toBe(3);
    expect(data.citation_coverage.pages_with_citations).toBe(3);
    expect(data.citation_coverage.ratio).toBe(1.0);
  });

  it("worst_pages ordering and tie-break by path", async () => {
    const v = makeVault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "doc.md"), "# Doc\n");

    // Page B: 2 findings
    writeFileSync(
      join(v, "concepts", "b.md"),
      FM(["rogue"]) + "Body without overview [[b]].\n"
    );
    // Page A: 2 findings (same count as B, should tie-break before B alphabetically)
    writeFileSync(
      join(v, "concepts", "a.md"),
      FM(["rogue"]) + "Body without overview [[a]].\n"
    );
    // Page C: 1 finding
    writeFileSync(
      join(v, "concepts", "c.md"),
      FM(["rogue"]) + "> **TL;DR:** C.\n\n## Overview\n\nContent C [[c]].\n\n## Related\n\n- [[c]]\n"
    );
    // Page D: clean
    writeFileSync(
      join(v, "concepts", "d.md"),
      FM(["model"]) + "> **TL;DR:** D.\n\n## Overview\n\nContent D [[d]].\n\n## Related\n\n- [[d]]\n"
    );
    writeFileSync(
      join(v, "index.md"),
      "# Index\n\n## Concepts\n- [[a]]\n- [[b]]\n- [[c]]\n- [[d]]\n"
    );

    const res = await runEval({ vault: v, top: 2 });
    expect(res.exitCode).toBe(ExitCode.OK);
    if (!res.result.ok) throw new Error("Expected ok");

    const worst = res.result.data.worst_pages;
    expect(worst.length).toBe(2);
    expect(worst[0].path).toBe("concepts/a.md");
    expect(worst[1].path).toBe("concepts/b.md");
    expect(worst[0].findings_count).toBe(worst[1].findings_count);
  });

  it("citation coverage ratio on a mixed fixture", async () => {
    const v = makeVault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(join(v, "raw", "articles", "doc1.md"), "# Doc 1\n");

    // Typed page 1: cited via frontmatter
    writeFileSync(
      join(v, "concepts", "c1.md"),
      FM(["model"], ["raw/articles/doc1.md"]) +
        "> **TL;DR:** c1.\n\n## Overview\n\nc1 [[c1]].\n\n## Related\n\n- [[c1]]\n"
    );
    // Typed page 2: cited via inline ^[raw/...]
    writeFileSync(
      join(v, "concepts", "c2.md"),
      FM(["model"], []) +
        "> **TL;DR:** c2.\n\n## Overview\n\nc2 ^[raw/articles/doc1.md] [[c2]].\n\n## Related\n\n- [[c2]]\n"
    );
    // Typed page 3: uncited
    writeFileSync(
      join(v, "concepts", "c3.md"),
      FM(["model"], []) +
        "> **TL;DR:** c3.\n\n## Overview\n\nc3 [[c3]].\n\n## Related\n\n- [[c3]]\n"
    );
    // Typed page 4: uncited
    writeFileSync(
      join(v, "concepts", "c4.md"),
      FM(["model"], []) +
        "> **TL;DR:** c4.\n\n## Overview\n\nc4 [[c4]].\n\n## Related\n\n- [[c4]]\n"
    );
    writeFileSync(
      join(v, "index.md"),
      "# Index\n\n## Concepts\n- [[c1]]\n- [[c2]]\n- [[c3]]\n- [[c4]]\n"
    );

    const res = await runEval({ vault: v });
    expect(res.exitCode).toBe(ExitCode.OK);
    if (!res.result.ok) throw new Error("Expected ok");

    expect(res.result.data.citation_coverage).toEqual({
      total_typed_pages: 4,
      pages_with_citations: 2,
      ratio: 0.5,
      definition: "Share of typed-knowledge pages carrying at least one canonical raw source citation via frontmatter sources or ^[raw/...] body markers",
    });
  });

  it("empty vault returns zero-valued valid report", async () => {
    const v = makeVault();
    const res = await runEval({ vault: v });
    expect(res.exitCode).toBe(ExitCode.OK);
    if (!res.result.ok) throw new Error("Expected ok");

    expect(res.result.data.pages_scanned).toBe(3); // SCHEMA.md, index.md, log.md
    expect(res.result.data.findings_total).toBe(0);
    expect(res.result.data.findings_by_severity).toEqual({
      error: 0,
      warning: 0,
      info: 0,
    });
    expect(res.result.data.citation_coverage).toEqual({
      total_typed_pages: 0,
      pages_with_citations: 0,
      ratio: 1.0,
      definition: "Share of typed-knowledge pages carrying at least one canonical raw source citation via frontmatter sources or ^[raw/...] body markers",
    });
    expect(res.result.data.worst_pages).toEqual([]);
  });

  it("bad --base ref returns USAGE", async () => {
    const v = makeVault();
    execFileSync("git", ["init"], { cwd: v });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: v });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: v });
    execFileSync("git", ["add", "."], { cwd: v });
    execFileSync("git", ["commit", "-m", "init"], { cwd: v });

    const res = await runEval({ vault: v, baseRef: "nonexistent-branch-or-ref" });
    expect(res.exitCode).toBe(ExitCode.USAGE);
    expect(res.result.ok).toBe(false);
  });

  it("--base delta over two fixture commits computes delta correctly", async () => {
    const v = makeVault();
    execFileSync("git", ["init"], { cwd: v });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: v });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: v });

    // Commit 1 (base): clean page alpha, no findings
    writeFileSync(
      join(v, "concepts", "alpha.md"),
      FM(["model"]) + "> **TL;DR:** Alpha.\n\n## Overview\n\nContent [[alpha]].\n\n## Related\n\n- [[alpha]]\n"
    );
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n");
    execFileSync("git", ["add", "."], { cwd: v });
    execFileSync("git", ["commit", "-m", "base commit"], { cwd: v });

    // Commit 2 (head): break alpha with rogue tag, add beta with bad tag
    writeFileSync(
      join(v, "concepts", "alpha.md"),
      FM(["rogue"]) + "> **TL;DR:** Alpha.\n\n## Overview\n\nContent [[alpha]].\n\n## Related\n\n- [[alpha]]\n"
    );
    writeFileSync(
      join(v, "concepts", "beta.md"),
      FM(["rogue"]) + "> **TL;DR:** Beta.\n\n## Overview\n\nContent [[beta]].\n\n## Related\n\n- [[beta]]\n"
    );
    writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n- [[alpha]]\n- [[beta]]\n");
    execFileSync("git", ["add", "."], { cwd: v });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: v });

    const res = await runEval({ vault: v, baseRef: "HEAD~1" });
    if (!res.result.ok) {
      console.log("FAIL RESULT:", res);
    }
    expect(res.exitCode).toBe(ExitCode.OK);
    if (!res.result.ok) throw new Error("Expected ok");

    const data = res.result.data;
    expect(data.delta).toBeDefined();
    expect(data.delta!.base_ref).toBe("HEAD~1");
    expect(data.delta!.findings_total_delta).toBeGreaterThan(0);
    expect(data.delta!.pages_worsened.length).toBeGreaterThanOrEqual(1);
  });
});
