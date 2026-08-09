import { describe, it, expect, vi } from "vitest";
import { printJson, printHuman } from "../../src/utils/output.js";
import { healthLintDetailHints, lintDetailHints } from "../../src/utils/lint-detail-hints.js";
import { ok, err } from "@skillwiki/shared";

describe("output", () => {
  it("printJson writes JSON.stringify of result + newline", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printJson(ok({ x: 1 }));
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ ok: true, data: { x: 1 } }) + "\n");
    spy.mockRestore();
  });

  it("printHuman renders ok results with a tag", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(ok({ msg: "hello" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("OK");
    expect(arg).toContain("hello");
    spy.mockRestore();
  });

  it("printHuman renders err results with the error code", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(err("HOST_BLOCKED", { host: "10.0.0.1" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("HOST_BLOCKED");
    spy.mockRestore();
  });

  it("printHuman uses humanHint when present on ok data", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(ok({ humanHint: "3 skills installed", count: 3 }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toBe("3 skills installed\n");
    expect(arg).not.toContain("OK");
    spy.mockRestore();
  });

  it("printHuman appends lint detail commands for non-empty error buckets in source order", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const data = {
      humanHint: "errors: 3\nwarnings: 1\ninfo: 0",
      by_severity: {
        error: [
          { kind: "broken_sources", items: ["a.md", "b.md"] },
          { kind: "tag_not_in_taxonomy", items: ["c.md"] },
          { kind: "path_too_long", items: [] },
        ],
        warning: [{ kind: "stale_page", items: ["d.md"] }],
        info: [],
      },
    };
    printHuman(ok(data), { detailHints: lintDetailHints(data) });

    const arg = spy.mock.calls[0][0] as string;
    expect(arg).toContain("detail: skillwiki lint --only broken_sources --examples 3");
    expect(arg).toContain("detail: skillwiki lint --only tag_not_in_taxonomy --examples 3");
    expect(arg).not.toContain("detail: skillwiki lint --only path_too_long");
    expect(arg).not.toContain("detail: skillwiki lint --only stale_page");
    expect(arg.indexOf("--only broken_sources")).toBeLessThan(arg.indexOf("--only tag_not_in_taxonomy"));
    spy.mockRestore();
  });

  it("printHuman supports bounded lint-summary buckets without changing the result", () => {
    const result = ok({
      humanHint: "errors: 2\nwarnings: 0\ninfo: 0",
      summary: { errors: 2, warnings: 0, info: 0 },
      buckets: [
        { kind: "conflict_markers", severity: "error", count: 1 },
        { kind: "invalid_frontmatter", severity: "error", count: 1 },
        { kind: "frontmatter_yaml_invalid", severity: "warning", count: 1 },
      ],
    });
    const jsonBefore = JSON.stringify(result) + "\n";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    printHuman(result, { detailHints: result.ok ? lintDetailHints(result.data) : [] });
    const human = spy.mock.calls[0][0] as string;
    expect(human).toContain("detail: skillwiki lint --only conflict_markers --examples 3");
    expect(human).toContain("detail: skillwiki lint --only invalid_frontmatter --examples 3");
    expect(human).not.toContain("detail: skillwiki lint --only frontmatter_yaml_invalid");
    expect(JSON.stringify(result) + "\n").toBe(jsonBefore);

    spy.mockClear();
    printJson(result);
    expect(spy).toHaveBeenCalledWith(jsonBefore);
    spy.mockRestore();
  });

  it("printHuman appends health detail commands from embedded lint error buckets only", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const data = {
      humanHint: "overall: error\nlint: 2 errors, 1 warnings, 0 info",
      components: {
        lint: {
          buckets: [
            { kind: "broken_wikilinks", severity: "error", count: 2 },
            { kind: "missing_overview", severity: "warning", count: 1 },
            { kind: "broken_sources", severity: "error", count: 0 },
          ],
        },
      },
    };
    printHuman(ok(data), { detailHints: healthLintDetailHints(data) });

    const arg = spy.mock.calls[0][0] as string;
    expect(arg).toContain("detail: skillwiki lint --only broken_wikilinks --examples 3");
    expect(arg).not.toContain("detail: skillwiki lint --only missing_overview");
    expect(arg).not.toContain("detail: skillwiki lint --only broken_sources");
    spy.mockRestore();
  });

  it("printHuman renders err without detail", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(err("SOME_ERROR"));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("ERR SOME_ERROR");
    spy.mockRestore();
  });

  it("printJson writes err result as JSON", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printJson(err("BOOM", { reason: "test" }));
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "BOOM", detail: { reason: "test" } }) + "\n");
    spy.mockRestore();
  });
});
