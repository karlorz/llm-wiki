import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHealth } from "../../src/commands/health.js";

const SCHEMA = `# Vault Schema

## Tag Taxonomy

\`\`\`yaml
taxonomy:
  - model
\`\`\`
`;

const FM = (tags: string[]) => `---
title: t
type: concept
tags: [${tags.join(", ")}]
sources: []
provenance: research
created: 2026-05-03
updated: 2026-05-03
---

`;

function makeHome(): string {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  mkdirSync(join(h, ".claude", "skills", "example"), { recursive: true });
  writeFileSync(join(h, ".claude", "skills", "example", "SKILL.md"), "# Example\n");
  return h;
}

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "health-vault-"));
  writeFileSync(join(v, "SCHEMA.md"), SCHEMA);
  writeFileSync(join(v, "index.md"), "# Index\n\n## Concepts\n");
  writeFileSync(join(v, "log.md"), "# Vault Log\n");
  for (const d of ["entities", "concepts", "comparisons", "queries", "meta", "raw", "raw/articles"]) {
    mkdirSync(join(v, d), { recursive: true });
  }
  return v;
}

describe("runHealth", () => {
  it("composes doctor, lint, vault-sync, query readiness, and risk flags into a bounded report", async () => {
    const home = makeHome();
    const vault = makeVault();
    writeFileSync(join(home, ".skillwiki", ".env"), `WIKI_PATH=${vault}\n`);
    writeFileSync(join(vault, "concepts", "bad-tag.md"), FM(["rogue"]) + "## Overview\n\nBad tag page [[bad-tag]].\n\n## Related\n\n- [[bad-tag]]\n");
    writeFileSync(join(vault, "concepts", "bad-source.md"), FM(["model"]).replace("sources: []", "sources: [raw/articles/missing.md]") + "## Overview\n\nBad source page [[bad-source]].\n\n## Related\n\n- [[bad-source]]\n");
    writeFileSync(join(vault, "index.md"), "# Index\n\n## Concepts\n- [[bad-tag]]\n- [[bad-source]]\n");

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "optional",
      noFail: false,
    });

    expect(r.exitCode).toBe(23);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      const data = r.result.data;
      expect(data.schema_version).toBe(1);
      expect(data.vault.path).toBe(vault);
      expect(data.components.doctor).toBeDefined();
      expect(data.components.lint.status).toBe("error");
      expect(data.components.vault_sync.status).toBe("error");
      expect(data.components.vault_sync.blocking).toBe(false);
      expect(data.components.query_readiness.status).toBe("error");
      expect(data.details_included).toBe(false);
      expect(data.truncated).toBe(false);
      expect(data.mutated).toBe(false);
      expect(data.report_complete).toBe(true);
      expect(data.self_check.status).toBe("pass");
      expect(data.coverage.lint.state).toBe("checked");
      expect(data.coverage.vault_sync.state).toBe("checked");
      const errorKinds = data.components.lint.buckets.filter(b => b.severity === "error").map(b => b.kind);
      expect(errorKinds).toContain("tag_not_in_taxonomy");
      expect(errorKinds).toContain("broken_sources");
      const errorTotal = data.components.lint.buckets
        .filter(b => b.severity === "error")
        .reduce((n, b) => n + b.count, 0);
      expect(errorTotal).toBe(data.components.lint.summary.errors);
      expect(data.risk_flags.map(f => f.id)).toContain("content_integrity_risk");
      expect(data.risk_flags.map(f => f.id)).toContain("retrieval_quality_risk");
    }
  });

  it("writes an explicit report file without marking vault knowledge mutated", async () => {
    const home = makeHome();
    const vault = makeVault();
    const out = join(tmpdir(), `skillwiki-health-${Date.now()}.json`);

    const r = await runHealth({
      vault,
      home,
      envValue: undefined,
      argv: ["node", "skillwiki", "health"],
      currentVersion: "0.8.5-test",
      sync: "off",
      noFail: true,
      out,
    });

    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.report_written).toBe(true);
      expect(r.result.data.report_path).toBe(out);
      expect(r.result.data.mutated).toBe(false);
      const written = JSON.parse(readFileSync(out, "utf8"));
      expect(written.ok).toBe(true);
      expect(written.data.schema_version).toBe(1);
      expect(written.data.report_written).toBe(true);
    }
  });
});
