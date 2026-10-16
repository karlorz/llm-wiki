import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "@skillwiki/shared";
import { runLint } from "../../src/lint/runner.js";
import { LINT_RULES } from "../../src/lint/rules.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "output-standard-v2");

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - documentation
  - model
\`\`\`
`;

const V2_BUCKETS = [
  "ste_sentence_length",
  "ste_hedge_words",
  "ste_diagram_uncertainty",
  "ste_comparison_visual",
] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stampDates(text: string): string {
  const d = today();
  return text.replace(/^created: .+$/m, `created: ${d}`).replace(/^updated: .+$/m, `updated: ${d}`);
}

function fm(opts: {
  title: string;
  type?: string;
  v2?: boolean;
  html?: boolean;
  extra?: string;
}): string {
  const lines = [
    "---",
    `title: ${opts.title}`,
    `created: ${today()}`,
    `updated: ${today()}`,
    `type: ${opts.type ?? "concept"}`,
    "tags: [documentation]",
    "sources: [raw/articles/x.md]",
    "provenance: research",
  ];
  if (opts.v2) lines.push("output_standard: v2");
  if (opts.html) lines.push("html_render: true");
  if (opts.extra) lines.push(opts.extra);
  lines.push("---", "");
  return lines.join("\n");
}

function vault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-v2-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw/articles"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  writeFileSync(join(v, "raw/articles/x.md"), "source\n");
  return v;
}

function v2Findings(result: { by_severity: { warning: Array<{ kind: string; items: unknown[] }> } }): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const bucket of result.by_severity.warning) {
    if ((V2_BUCKETS as readonly string[]).includes(bucket.kind)) out[bucket.kind] = bucket.items;
  }
  return out;
}

async function lintVault(v: string, only?: string) {
  return runLint({
    vault: v,
    days: 90,
    lines: 200,
    logThreshold: 500,
    only,
  });
}

describe("output standard v2 lint", () => {
  it("registers the four v2 warning rules", () => {
    const ids = LINT_RULES.map((rule) => rule.id);
    for (const id of V2_BUCKETS) expect(ids).toContain(id);
  });

  it("yields zero v2 findings on unmarked pages", async () => {
    const v = vault();
    const long = Array.from({ length: 26 }, (_, i) => `w${i + 1}`).join(" ") + ".";
    writeFileSync(join(v, "concepts/unmarked.md"), fm({ title: "Unmarked" }) + `## Overview\n\n${long}\nThis might break.\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n`);
    writeFileSync(join(v, "comparisons/plain.md"), fm({ title: "Plain", type: "comparison" }) + "## Overview\n\nNo table.\n");

    const res = await lintVault(v);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    expect(v2Findings(res.result.data)).toEqual({});
  });

  it("fires each v2 bucket on a bad marked fixture", async () => {
    const v = vault();
    const long = Array.from({ length: 26 }, (_, i) => `w${i + 1}`).join(" ") + ".";
    writeFileSync(join(v, "concepts/long.md"), fm({ title: "Long", v2: true }) + `## Overview\n\n${long}\n`);
    writeFileSync(join(v, "concepts/hedge.md"), fm({ title: "Hedge", v2: true }) + "## Overview\n\nThis might break later.\n");
    writeFileSync(join(v, "concepts/diagram.md"), fm({ title: "Diagram", v2: true }) + "## Overview\n\n```mermaid\nflowchart TD\n  A --> B\n```\n");
    writeFileSync(join(v, "comparisons/novisual.md"), fm({ title: "No Visual", type: "comparison", v2: true }) + "## Overview\n\nNo table.\n");

    const res = await lintVault(v);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    const findings = v2Findings(res.result.data);
    expect(findings.ste_sentence_length?.some((item) => String(item).includes("concepts/long.md"))).toBe(true);
    expect(findings.ste_hedge_words?.some((item) => String(item).includes("concepts/hedge.md"))).toBe(true);
    expect(findings.ste_diagram_uncertainty?.some((item) => String(item).includes("concepts/diagram.md"))).toBe(true);
    expect(findings.ste_comparison_visual?.some((item) => String(item).includes("comparisons/novisual.md"))).toBe(true);
  });

  it("does not change the lint exit code when v2 findings are present", async () => {
    const long = Array.from({ length: 26 }, (_, i) => `w${i + 1}`).join(" ") + ".";
    const unmarked = vault();
    writeFileSync(join(unmarked, "concepts/page.md"), fm({ title: "Page" }) + `## Overview\n\n${long}\n`);
    const marked = vault();
    writeFileSync(join(marked, "concepts/page.md"), fm({ title: "Page", v2: true }) + `## Overview\n\n${long}\n`);

    const unmarkedRes = await lintVault(unmarked);
    const markedRes = await lintVault(marked);
    expect(markedRes.exitCode).toBe(unmarkedRes.exitCode);

    const onlyMarked = await lintVault(marked, "ste_sentence_length");
    expect(onlyMarked.result.ok).toBe(true);
    if (!onlyMarked.result.ok) return;
    expect(onlyMarked.result.data.by_severity.warning[0]?.items.length).toBeGreaterThan(0);
    expect(onlyMarked.exitCode).toBe(ExitCode.OK);
  });

  it("yields zero v2 findings on the four sample fixtures", async () => {
    const v = vault();
    const samples = [
      ["entities/entity-sample.md", "entity-sample.md"],
      ["concepts/concept-sample.md", "concept-sample.md"],
      ["comparisons/comparison-sample.md", "comparison-sample.md"],
    ] as const;
    for (const [dest, file] of samples) {
      writeFileSync(join(v, dest), stampDates(readFileSync(join(FIXTURE_DIR, file), "utf8")));
    }
    writeFileSync(join(v, "concepts/ingest-output-standard-v2.md"), stampDates(readFileSync(join(FIXTURE_DIR, "concepts-ingest-output-standard-v2.md"), "utf8")));
    writeFileSync(join(v, "raw/articles/output-standard-v2-entity.md"), "source\n");
    writeFileSync(join(v, "raw/articles/output-standard-v2-concept.md"), "source\n");
    writeFileSync(join(v, "raw/articles/output-standard-v2-comparison.md"), "source\n");
    writeFileSync(join(v, "raw/articles/ingest-output-standard-v2.md"), "source\n");

    const res = await lintVault(v);
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    expect(v2Findings(res.result.data)).toEqual({});
  });
});
