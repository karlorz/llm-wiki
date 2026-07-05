import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/commands/links.js", () => ({
  runLinks: vi.fn(async () => {
    throw new Error("runLinks should not be called for file_source_url-only lint");
  }),
}));

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-file-source-only-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "meta", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("runLint --only file_source_url", () => {
  it("does not execute unrelated lint buckets before filtering", async () => {
    const { runLint } = await import("../../src/commands/lint.js");
    const v = vault();
    mkdirSync(join(v, "raw", "articles"), { recursive: true });
    writeFileSync(
      join(v, "raw", "articles", "local-file.md"),
      `---\nsource_url: file:///Users/me/Downloads/article.html\ningested: 2026-07-05\nsha256: abc123\n---\n\ncontent\n`,
    );

    const result = await runLint({ vault: v, days: 90, lines: 200, logThreshold: 500, only: "file_source_url" });

    expect(result.result.ok).toBe(true);
    if (result.result.ok) {
      expect(result.result.data.by_severity.warning).toEqual([
        { kind: "file_source_url", items: ["raw/articles/local-file.md"] },
      ]);
    }
  });
});
