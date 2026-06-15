import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runValidate } from "../../src/commands/validate.js";

const F = (n: string) => join(__dirname, "..", "fixtures", n);

describe("validate", () => {
  it("returns valid=true for a Hermes-shaped concept", async () => {
    const r = await runValidate({ file: F("valid-concept.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("typed-knowledge");
    }
  });

  it("returns INVALID_FRONTMATTER with field errors", async () => {
    const r = await runValidate({ file: F("invalid-concept.md") });
    expect(r.exitCode).toBe(7);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("returns SCHEMA_NOT_DETECTED for unknown shape", async () => {
    const r = await runValidate({ file: F("no-schema.md") });
    expect(r.exitCode).toBe(8);
  });

  it("returns FILE_NOT_FOUND for missing file", async () => {
    const r = await runValidate({ file: "/no/such/file" });
    expect(r.exitCode).toBe(2);
  });

  it("returns valid=true for a meta page with ≥2 provenance_projects", async () => {
    const r = await runValidate({ file: F("valid-meta.md") });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("meta");
    }
  });

  it("validates page with empty tags array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const file = join(dir, "empty-tags.md");
    writeFileSync(file, `---
title: No Tags
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: []
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("typed-knowledge");
    }
  });

  it("rejects page with non-string tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const file = join(dir, "bad-tags.md");
    writeFileSync(file, `---
title: Bad Tags
created: 2026-05-03
updated: 2026-05-03
type: concept
tags: [123]
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file });
    expect(r.exitCode).toBe(7);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.some(e => e.path.startsWith("tags"))).toBe(true);
    }
  });

  it("--apply updates index.md and log.md on valid typed-knowledge page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(dir, "index.md"), "## Concepts\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "concepts", "test-concept.md");
    writeFileSync(file, `---
title: Test Concept
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [testing]
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.index_updated).toBe(true);
      expect(r.result.data.log_updated).toBe(true);
    }
    // Verify index.md was updated with relPath-based wikilink
    const indexContent = readFileSync(join(dir, "index.md"), "utf8");
    expect(indexContent).toContain("[[concepts/test-concept]]");
    expect(indexContent).toContain("Test Concept");
    // Verify log.md was updated
    const logContent = readFileSync(join(dir, "log.md"), "utf8");
    expect(logContent).toContain("validate | added: concepts/test-concept.md");
  });

  it("--apply does not update index.md when page already listed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(dir, "index.md"), "## Concepts\n\n- [[concepts/test-concept]] — Already here\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "concepts", "test-concept.md");
    writeFileSync(file, `---
title: Test Concept
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: [testing]
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, vault: dir, apply: true });
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.index_updated).toBe(false);
      expect(r.result.data.log_updated).toBe(true); // log still gets appended
    }
  });

  it("--apply without vault returns VAULT_PATH_INVALID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const file = join(dir, "concept.md");
    writeFileSync(file, `---
title: No Vault
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: []
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, apply: true });
    expect(r.exitCode).toBe(9); // VAULT_PATH_INVALID
    expect(r.result.ok).toBe(false);
  });

  it("--apply with file outside vault returns VAULT_PATH_INVALID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const vaultDir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(vaultDir, "index.md"), "## Concepts\n");
    writeFileSync(join(vaultDir, "log.md"), "# Log\n");
    const file = join(dir, "outside-vault.md");
    writeFileSync(file, `---
title: Outside
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: []
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, apply: true, vault: vaultDir });
    expect(r.exitCode).toBe(9); // VAULT_PATH_INVALID
    expect(r.result.ok).toBe(false);
  });

  it("--apply skips index.md update for raw schema (only appends to log.md)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "raw", "articles"), { recursive: true });
    writeFileSync(join(dir, "index.md"), "## Entities\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "raw", "articles", "source.md");
    writeFileSync(file, `---
title: Raw Source
source_url: null
ingested: 2026-05-09
sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
---

Body.
`);
    const r = await runValidate({ file, vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(true);
      expect(r.result.data.schema).toBe("raw");
      expect(r.result.data.index_updated).toBe(false);
      expect(r.result.data.log_updated).toBe(true);
    }
  });

  it("--apply adds entity page under Entities section", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "entities"), { recursive: true });
    writeFileSync(join(dir, "index.md"), "## Entities\n- [[entities/existing]] — Old\n\n## Concepts\n- [[concepts/other]] — Other\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "entities", "new-entity.md");
    writeFileSync(file, `---
title: New Entity
created: 2026-05-09
updated: 2026-05-09
type: entity
tags: [testing]
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.index_updated).toBe(true);
      expect(r.result.data.log_updated).toBe(true);
    }
    const indexContent = readFileSync(join(dir, "index.md"), "utf8");
    expect(indexContent).toContain("[[entities/new-entity]]");
    expect(indexContent).toContain("New Entity");
    // Concepts section should remain intact
    expect(indexContent).toContain("[[concepts/other]]");
  });

  it("--apply creates new section in index.md when section does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "queries"), { recursive: true });
    writeFileSync(join(dir, "index.md"), "## Concepts\n- [[concepts/alpha]] — Alpha\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "queries", "search.md");
    writeFileSync(file, `---
title: Search Query
created: 2026-05-09
updated: 2026-05-09
type: query
tags: [search]
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.index_updated).toBe(true);
    }
    const indexContent = readFileSync(join(dir, "index.md"), "utf8");
    expect(indexContent).toContain("## Queries");
    expect(indexContent).toContain("[[queries/search]]");
  });

  it("without --apply does not modify index.md or log.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "index.md"), "## Concepts\n");
    writeFileSync(join(dir, "log.md"), "# Log\n");
    const file = join(dir, "concepts", "test.md");
    writeFileSync(file, `---
title: Test
created: 2026-05-09
updated: 2026-05-09
type: concept
tags: []
sources: [raw/articles/x.md]
---

Body.
`);
    const r = await runValidate({ file, vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.index_updated).toBe(false);
      expect(r.result.data.log_updated).toBe(false);
    }
    // Verify files were not modified
    expect(readFileSync(join(dir, "index.md"), "utf8")).toBe("## Concepts\n");
    expect(readFileSync(join(dir, "log.md"), "utf8")).toBe("# Log\n");
  });

  it("rejects sensitive content without exposing the value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const file = join(dir, "secret.md");
    const secret = "hana_" + "dev_" + "A".repeat(43);
    writeFileSync(file, `---
title: Secret
created: 2026-06-15
updated: 2026-06-15
type: query
tags: [security]
sources: [raw/articles/x.md]
---

# Secret

Access key: ${secret}
`);

    const r = await runValidate({ file });

    expect(r.exitCode).toBe(51);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.valid).toBe(false);
      expect(r.result.data.errors.some(e => e.path === "sensitive_content")).toBe(true);
      expect(JSON.stringify(r.result.data)).not.toContain(secret);
    }
  });

  it("accepts redacted sensitive placeholders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const file = join(dir, "redacted.md");
    writeFileSync(file, `---
title: Redacted
created: 2026-06-15
updated: 2026-06-15
type: query
tags: [security]
sources: [raw/articles/x.md]
---

# Redacted

Access key: [REDACTED:access_key:abc123]
`);

    const r = await runValidate({ file });

    expect(r.exitCode).toBe(0);
  });
});
