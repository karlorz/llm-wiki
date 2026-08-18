import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LintRunner } from "../../src/lint/runner.js";
import { LINT_RULES } from "../../src/lint/rules.js";
import type { LintRuleModule, LintRuleContext, LintRuleResult } from "../../src/lint/types.js";
import { runLint } from "../../src/lint/runner.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

function createEmptyVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-runner-test-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "raw"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("LintRunner rule enumeration and registration", () => {
  it("enumerates all default rule modules", () => {
    const runner = new LintRunner();
    const rules = runner.getRegisteredRules();
    expect(rules.length).toBe(LINT_RULES.length);
    expect(rules.map((r) => r.id)).toContain("broken_wikilinks");
    expect(rules.map((r) => r.id)).toContain("tag_not_in_taxonomy");
    expect(rules.map((r) => r.id)).toContain("cli_refs");
    expect(rules.map((r) => r.id)).toContain("file_source_url");
    expect(rules.map((r) => r.id)).toContain("path_too_long");
  });

  it("finds rule for primary bucket id and produced buckets", () => {
    const runner = new LintRunner();
    const linkRule = runner.findRuleForBucket("broken_wikilinks");
    expect(linkRule).toBeDefined();
    expect(linkRule?.id).toBe("broken_wikilinks");

    const orphanRule = runner.findRuleForBucket("bridges");
    expect(orphanRule).toBeDefined();
    expect(orphanRule?.producedBuckets).toContain("bridges");
  });
});

describe("LintRunner custom rule execution and selection", () => {
  it("allows registering custom rule modules in a runner instance", async () => {
    const customRule: LintRuleModule = {
      id: "custom_check",
      severity: "warning",
      async run(ctx: LintRuleContext): Promise<LintRuleResult> {
        return {
          buckets: {
            custom_check: [`flagged: ${ctx.vault}`],
          },
        };
      },
    };

    const runner = new LintRunner([...LINT_RULES, customRule]);
    expect(runner.getRegisteredRules().map((r) => r.id)).toContain("custom_check");
  });

  it("filters execution by rule id with --only flag", async () => {
    const v = createEmptyVault();
    const res = await runLint({
      vault: v,
      days: 90,
      lines: 200,
      logThreshold: 500,
      only: "cli_refs",
    });

    expect(res.exitCode).toBe(0);
    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.data.by_severity.error).toEqual([]);
      expect(res.result.data.by_severity.warning).toEqual([]);
      expect(res.result.data.by_severity.info).toEqual([]);
    }
  });
});
