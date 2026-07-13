import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTargetInsideVault,
  prepareTypedPage,
  validateTypedTarget,
} from "../../src/utils/typed-page.js";

const QUERY = `---
title: Test Query
created: 2026-07-13
updated: 2026-07-13
type: query
tags: [research, new-tag]
sources: [raw/articles/source.md]
confidence: medium
---

# Test Query

Body. ^[raw/articles/source.md]

## Sources

- ^[raw/articles/source.md]
`;

const META = `---
title: Session Brief
created: 2026-07-13
updated: 2026-07-13
type: meta
tags: [research]
generated_by: test
generated_at: 2026-07-13T00:00:00.000Z
generated_kind: session-brief
---

# Session Brief
`;

function makeVault(): string {
  const vault = mkdtempSync(join(tmpdir(), "typed-page-vault-"));
  for (const directory of ["entities", "concepts", "comparisons", "queries", "meta"]) {
    mkdirSync(join(vault, directory), { recursive: true });
  }
  return vault;
}

describe("typed-page", () => {
  it("prepares exact query bytes and a frozen tag set", () => {
    const result = prepareTypedPage(QUERY, "queries/test-query.md");

    expect(result).toMatchObject({
      ok: true,
      data: {
        target: "queries/test-query.md",
        title: "Test Query",
        type: "query",
        tags: ["research", "new-tag"],
        content: QUERY,
      },
    });
  });

  it("preserves frozen content bytes without normalizing line endings or whitespace", () => {
    const content = QUERY.replace(/\n/g, "\r\n") + "\t";
    const result = prepareTypedPage(content, "queries/byte-exact.md");

    expect(result).toMatchObject({ ok: true, data: { content } });
  });

  it.each([
    "",
    "/absolute.md",
    "queries/../escape.md",
    "queries/./dot.md",
    "queries//double.md",
    "raw/articles/no.md",
    "projects/llm-wiki/work/x/spec.md",
    "queries/no-extension",
    "queries\\windows.md",
  ])("rejects unsafe target %s", (target) => {
    expect(validateTypedTarget(target).ok).toBe(false);
  });

  it("rejects a type/directory mismatch", () => {
    expect(prepareTypedPage(QUERY, "concepts/test-query.md").ok).toBe(false);
  });

  it("rejects malformed frontmatter", () => {
    expect(prepareTypedPage("---\ntitle: missing closing delimiter\n", "queries/malformed.md")).toMatchObject({
      ok: false,
      error: "MISSING_CLOSING_DELIMITER",
    });
  });

  it("rejects frontmatter whose tags are not strings", () => {
    const content = QUERY.replace("tags: [research, new-tag]", "tags: [research, 42]");
    expect(prepareTypedPage(content, "queries/non-string-tags.md")).toMatchObject({
      ok: false,
      error: "INVALID_FRONTMATTER",
    });
  });

  it("accepts meta only below the meta directory", () => {
    expect(prepareTypedPage(META, "meta/session-brief.md")).toMatchObject({ ok: true, data: { type: "meta" } });
    expect(prepareTypedPage(META, "queries/session-brief.md")).toMatchObject({
      ok: false,
      error: "SCHEME_REJECTED",
    });
  });

  it("rejects a symlink target even when its parent is inside the vault", () => {
    const vault = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "typed-page-outside-"));
    writeFileSync(join(outside, "escape.md"), "outside\n");
    symlinkSync(join(outside, "escape.md"), join(vault, "queries", "escape.md"));

    expect(assertTargetInsideVault(vault, "queries/escape.md")).toMatchObject({
      ok: false,
      error: "VAULT_PATH_INVALID",
    });
  });

  it("returns an error result when the vault cannot be realpathed", () => {
    const missing = join(tmpdir(), `typed-page-missing-${Date.now()}`);
    expect(() => assertTargetInsideVault(missing, "queries/test.md")).not.toThrow();
    expect(assertTargetInsideVault(missing, "queries/test.md")).toMatchObject({
      ok: false,
      error: "VAULT_PATH_INVALID",
    });
  });

  it("returns an error result when the target parent cannot be realpathed", () => {
    const vault = mkdtempSync(join(tmpdir(), "typed-page-no-parent-"));
    expect(() => assertTargetInsideVault(vault, "queries/test.md")).not.toThrow();
    expect(assertTargetInsideVault(vault, "queries/test.md")).toMatchObject({
      ok: false,
      error: "VAULT_PATH_INVALID",
    });
  });

  it("rejects a target parent that resolves outside the vault", () => {
    const vault = makeVault();
    const outside = mkdtempSync(join(tmpdir(), "typed-page-parent-outside-"));
    rmSync(join(vault, "queries"), { recursive: true });
    symlinkSync(outside, join(vault, "queries"));

    expect(assertTargetInsideVault(vault, "queries/escape.md")).toMatchObject({
      ok: false,
      error: "VAULT_PATH_INVALID",
    });
  });

  it("rejects sensitive body content before publication", () => {
    const sensitive = `${QUERY}\napi_key: sk-${"a".repeat(24)}\n`;
    expect(prepareTypedPage(sensitive, "queries/sensitive.md")).toMatchObject({
      ok: false,
      error: "SENSITIVE_CONTENT_DETECTED",
    });
  });
});
