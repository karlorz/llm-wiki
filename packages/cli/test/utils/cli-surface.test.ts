import { describe, it, expect } from "vitest";
import { buildCliSurface, validateCliRefs } from "../../src/utils/cli-surface.js";

describe("buildCliSurface", () => {
  const surface = buildCliSurface();

  it("registers top-level commands", () => {
    expect(surface.has("stale")).toBe(true);
    expect(surface.has("lint")).toBe(true);
    expect(surface.has("health")).toBe(true);
    expect(surface.has("doctor")).toBe(true);
    expect(surface.has("log-rotate")).toBe(true);
    expect(surface.has("log-append")).toBe(true);
  });

  it("keeps log-append in sync with cli.ts (--content)", () => {
    expect(surface.get("log-append")!.has("--content")).toBe(true);
  });

  it("registers nested subcommands with dot keys", () => {
    expect(surface.has("graph.build")).toBe(true);
    expect(surface.has("tag.reconcile")).toBe(true);
    expect(surface.has("sync.status")).toBe(true);
    expect(surface.has("config.list")).toBe(true);
    expect(surface.has("backup.restore")).toBe(true);
  });

  it("includes the root --human flag on every command", () => {
    for (const flags of surface.values()) {
      expect(flags.has("--human")).toBe(true);
    }
  });

  it("captures command-specific flags", () => {
    expect(surface.get("stale")!.has("--days")).toBe(true);
    expect(surface.get("stale")!.has("--archive")).toBe(true);
    expect(surface.get("graph.build")!.has("--out")).toBe(true);
    expect(surface.get("lint")!.has("--summary")).toBe(true);
    expect(surface.get("health")!.has("--no-fail")).toBe(true);
    expect(surface.get("health")!.has("--out")).toBe(true);
    expect(surface.get("memory.index")!.has("--check")).toBe(true);
    expect(surface.get("memory.index")!.has("--if-stale")).toBe(true);
    expect(surface.get("memory.recall")!.has("--scope")).toBe(true);
    expect(surface.get("memory.review")!.has("--dry-run")).toBe(true);
    expect(surface.get("memory.review")!.has("--pre-action")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--page")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--from")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--tags")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--reason")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--write")).toBe(true);
    expect(surface.get("tag.reconcile")!.has("--wiki")).toBe(true);
  });

  it("subcommand flag sets inherit parent + root flags", () => {
    // graph.build inherits --human from root
    expect(surface.get("graph.build")!.has("--human")).toBe(true);
  });
});

describe("validateCliRefs", () => {
  const surface = buildCliSurface();
  const v = (text: string) => validateCliRefs(text, "page.md", surface);

  it("accepts a valid command + flag reference", () => {
    expect(v("Run `skillwiki stale --days 30` to scan.")).toEqual([]);
  });

  it("accepts a valid two-word subcommand reference", () => {
    expect(v("Use `skillwiki sync status` for state.")).toEqual([]);
    expect(v("Use `skillwiki graph build --out g.json`.")).toEqual([]);
  });

  it("accepts a tag reconcile reference with prospective-tag flags", () => {
    expect(v("Preview with `skillwiki tag reconcile --page queries/report.md --tags alpha,beta`.")).toEqual([]);
  });

  it("accepts a log-append reference with --content", () => {
    expect(v("Append via `skillwiki log-append --content x`.")).toEqual([]);
  });

  it("accepts health and lint summary references", () => {
    expect(v("Check via `skillwiki health --sync off --no-fail --out /tmp/h.json`.")).toEqual([]);
    expect(v("Summarize via `skillwiki lint --summary --examples 2`.")).toEqual([]);
  });

  it("accepts a memory review pre-action reference", () => {
    expect(v("Run `skillwiki memory review --project llm-wiki --pre-action packages/cli/src/utils/cli-surface.ts --dry-run` before implementation.")).toEqual([]);
  });

  it("flags an unknown command", () => {
    const out = v("Run `skillwiki bogus`.");
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("unknown_command");
  });

  it("flags an unknown flag on a valid command", () => {
    const out = v("Run `skillwiki stale --nope`.");
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("unknown_flag");
  });

  it("flags an unknown subcommand under a parent that has subcommands", () => {
    const out = v("Run `skillwiki sync deploy`.");
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("unknown_command");
  });

  it("ignores prose without backticks", () => {
    expect(v("skillwiki also provides a stale --nonsense option in prose")).toEqual([]);
  });

  it("records the page name on violations", () => {
    const out = v("`skillwiki bogus`");
    expect(out[0].page).toBe("page.md");
  });
});
