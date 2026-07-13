import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndexUpsert, upsertIndexEntry } from "../../src/utils/index-entry.js";

function makeVault(index: string): string {
  const vault = mkdtempSync(join(tmpdir(), "index-entry-vault-"));
  writeFileSync(join(vault, "index.md"), index);
  return vault;
}

describe("index-entry", () => {
  it("inserts one query entry before the next section", async () => {
    const vault = makeVault("## Queries\n\n## Comparisons\n- [[comparisons/x]] — X\n");
    const result = await upsertIndexEntry({
      vault,
      target: "queries/test-query.md",
      title: "Test Query",
      type: "query",
    });

    expect(result).toEqual({ ok: true, data: { changed: true } });
    expect(readFileSync(join(vault, "index.md"), "utf8")).toContain(
      "## Queries\n- [[queries/test-query]] — Test Query\n\n## Comparisons",
    );
  });

  it("is an mtime-preserving no-op when the target link already exists", async () => {
    const vault = makeVault("## Queries\n- [[queries/test-query]] — Old title\n");
    const before = statSync(join(vault, "index.md")).mtimeMs;

    const result = await upsertIndexEntry({
      vault,
      target: "queries/test-query.md",
      title: "New title",
      type: "query",
    });

    expect(result).toEqual({ ok: true, data: { changed: false } });
    expect(statSync(join(vault, "index.md")).mtimeMs).toBe(before);
  });

  it("adds only the entry bytes and preserves CRLF plus unrelated sections", () => {
    const current = "# Index\r\n\r\n## Queries\r\n\r\n## Comparisons\r\n- [[comparisons/x]] — X\r\n";
    const result = renderIndexUpsert(current, {
      target: "queries/test-query.md",
      title: "Test Query",
      type: "query",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        text: "# Index\r\n\r\n## Queries\r\n- [[queries/test-query]] — Test Query\r\n\r\n## Comparisons\r\n- [[comparisons/x]] — X\r\n",
        changed: true,
      },
    });
  });

  it("adds a missing typed section without rewriting the existing document", () => {
    const current = "# Index\n\n## Queries\n- [[queries/existing]] — Existing\n";
    const result = renderIndexUpsert(current, {
      target: "meta/session-brief.md",
      title: "Session Brief",
      type: "meta",
    });

    expect(result).toEqual({
      ok: true,
      data: {
        text: "# Index\n\n## Queries\n- [[queries/existing]] — Existing\n\n## Meta\n- [[meta/session-brief]] — Session Brief\n",
        changed: true,
      },
    });
  });

  it("rejects a multiline title without changing rendered text", () => {
    const current = "## Queries\n";
    expect(renderIndexUpsert(current, {
      target: "queries/test-query.md",
      title: "Test\nQuery",
      type: "query",
    })).toMatchObject({ ok: false, error: "SCHEME_REJECTED" });
  });
});
