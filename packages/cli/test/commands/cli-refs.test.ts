import { describe, it, expect } from "vitest";
import { buildCliSurface, validateCliRefs } from "../../src/utils/cli-surface.js";

describe("buildCliSurface", () => {
  it("includes top-level commands", () => {
    const surface = buildCliSurface();
    expect(surface.has("stale")).toBe(true);
    expect(surface.has("lint")).toBe(true);
    expect(surface.has("init")).toBe(true);
    expect(surface.has("health")).toBe(true);
    expect(surface.has("doctor")).toBe(true);
  });

  it("includes subcommands with dot-separated keys", () => {
    const surface = buildCliSurface();
    expect(surface.has("graph.build")).toBe(true);
    expect(surface.has("sync.status")).toBe(true);
    expect(surface.has("sync.push")).toBe(true);
    expect(surface.has("sync.lock")).toBe(true);
    expect(surface.has("sync.unlock")).toBe(true);
    expect(surface.has("sync.peers")).toBe(true);
    expect(surface.has("config.get")).toBe(true);
    expect(surface.has("config.set")).toBe(true);
    expect(surface.has("compound.promote")).toBe(true);
    expect(surface.has("backup.sync")).toBe(true);
    expect(surface.has("backup.restore")).toBe(true);
  });

  it("includes valid flags for each command", () => {
    const surface = buildCliSurface();
    expect(surface.get("stale")!.has("--archive")).toBe(true);
    expect(surface.get("stale")!.has("--days")).toBe(true);
    expect(surface.get("stale")!.has("--force-scan")).toBe(true);
    expect(surface.get("stale")!.has("--wiki")).toBe(true);
    expect(surface.get("lint")!.has("--fix")).toBe(true);
    expect(surface.get("lint")!.has("--days")).toBe(true);
    expect(surface.get("lint")!.has("--summary")).toBe(true);
    expect(surface.get("lint")!.has("--examples")).toBe(true);
    expect(surface.get("health")!.has("--sync")).toBe(true);
    expect(surface.get("health")!.has("--no-fail")).toBe(true);
    expect(surface.get("health")!.has("--out")).toBe(true);
    expect(surface.get("init")!.has("--force")).toBe(true);
    expect(surface.get("init")!.has("--domain")).toBe(true);
    expect(surface.get("archive")!.has("--cascade")).toBe(true);
    expect(surface.get("archive")!.has("--apply")).toBe(true);
    expect(surface.get("sync.lock")!.has("--summary")).toBe(true);
    expect(surface.get("sync.lock")!.has("--ttl-minutes")).toBe(true);
    expect(surface.get("sync.unlock")!.has("--force")).toBe(true);
    expect(surface.get("session-brief")!.has("--write")).toBe(true);
    expect(surface.get("session-brief")!.has("--project")).toBe(true);
    expect(surface.get("session-brief")!.has("--wiki")).toBe(true);
    expect(surface.get("memory.topics")!.has("--project")).toBe(true);
    expect(surface.get("memory.topics")!.has("--limit")).toBe(true);
    expect(surface.get("memory.topics")!.has("--wiki")).toBe(true);
    expect(surface.get("memory.index")!.has("--project")).toBe(true);
    expect(surface.get("memory.index")!.has("--check")).toBe(true);
    expect(surface.get("memory.index")!.has("--if-stale")).toBe(true);
    expect(surface.get("memory.index")!.has("--wiki")).toBe(true);
    expect(surface.get("memory.recall")!.has("--project")).toBe(true);
    expect(surface.get("memory.recall")!.has("--topic")).toBe(true);
    expect(surface.get("memory.recall")!.has("--scope")).toBe(true);
    expect(surface.get("memory.recall")!.has("--limit")).toBe(true);
    expect(surface.get("memory.recall")!.has("--wiki")).toBe(true);
    expect(surface.get("memory.import")!.has("--from")).toBe(true);
    expect(surface.get("memory.import")!.has("--project")).toBe(true);
    expect(surface.get("memory.import")!.has("--dry-run")).toBe(true);
    expect(surface.get("memory.import")!.has("--apply")).toBe(true);
    expect(surface.get("memory.import")!.has("--max-bytes")).toBe(true);
    expect(surface.get("memory.import")!.has("--wiki")).toBe(true);
  });

  it("includes --human flag inherited from root on all commands", () => {
    const surface = buildCliSurface();
    expect(surface.get("stale")!.has("--human")).toBe(true);
    expect(surface.get("graph.build")!.has("--human")).toBe(true);
  });

  it("does not include non-existent flags", () => {
    const surface = buildCliSurface();
    expect(surface.get("stale")!.has("--unclaimed")).toBe(false);
    expect(surface.get("stale")!.has("--project")).toBe(true);
    expect(surface.get("lint")!.has("--only")).toBe(true);
    expect(surface.get("lint")!.has("--bucket")).toBe(false);
  });
});

describe("validateCliRefs", () => {
  const surface = buildCliSurface();

  it("returns no violations for valid command refs in backticks", () => {
    const text = "Run `skillwiki lint` to check vault health.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("returns no violations for valid command+flag refs in backticks", () => {
    const text = "Run `skillwiki lint --fix` to auto-fix issues. Also `skillwiki init --force`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("returns no violations for health and lint summary refs", () => {
    const text = "Run `skillwiki health --out /tmp/skillwiki-health.json --no-fail` and `skillwiki lint --summary --examples 3`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("returns no violations for valid subcommand refs in backticks", () => {
    const text = "Run `skillwiki sync status` to check sync. Also `skillwiki graph build`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("returns no violations for valid subcommand+flag refs", () => {
    const text = "Run `skillwiki project-index --apply` to regenerate.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("flags unknown command", () => {
    const text = "Run `skillwiki nonexistent` to do something.";
    const violations = validateCliRefs(text, "test.md", surface);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toBe("unknown_command");
    expect(violations[0]!.ref).toBe("skillwiki nonexistent");
  });

  it("flags unknown flag on known command", () => {
    const text = "Run `skillwiki stale --unclaimed` to find unclaimed transcripts.";
    const violations = validateCliRefs(text, "test.md", surface);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toBe("unknown_flag");
    expect(violations[0]!.ref).toBe("skillwiki stale --unclaimed");
  });

  it("accepts --project on stale (now a valid flag)", () => {
    const text = "Run `skillwiki stale --project zzapi-mes` to check.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts --only on lint (now a valid flag), flags --bucket (does not exist)", () => {
    const text = "Use `skillwiki lint --only links` or `skillwiki lint --bucket broken_wikilinks`.";
    const violations = validateCliRefs(text, "test.md", surface);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toBe("unknown_flag");
    expect(violations[0]!.ref).toContain("--bucket");
  });

  it("ignores prose references without backticks", () => {
    const text = "skillwiki also provides a lint command for vault health.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("validates multiple flags independently", () => {
    const text = "Run `skillwiki stale --archive --unclaimed`.";
    const violations = validateCliRefs(text, "test.md", surface);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toBe("unknown_flag");
  });

  it("flags invalid subcommand", () => {
    const text = "Run `skillwiki sync deploy`.";
    const violations = validateCliRefs(text, "test.md", surface);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toBe("unknown_command");
  });

  it("accepts --wiki flag on subcommands (inherited from parent)", () => {
    const text = "Run `skillwiki sync status --wiki myvault`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts --dry-run on compound promote", () => {
    const text = "Run `skillwiki compound promote --project llm-wiki --dry-run`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts sync lock/unlock/peers current command surface", () => {
    const text = "Run `skillwiki sync lock --summary test --ttl-minutes 30` then `skillwiki sync peers` and `skillwiki sync unlock --force`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts archive cascade/apply flags", () => {
    const text = "Run `skillwiki archive concepts/foo.md --cascade --apply`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts session-brief command refs", () => {
    const text = "Run `skillwiki session-brief --project auto --write` to refresh startup memory.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts memory topics command refs", () => {
    const text = "Run `skillwiki memory topics --project llm-wiki --limit 3` to list topic memory.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts memory index and recall command refs", () => {
    const text = "Run `skillwiki memory index --project llm-wiki --check`, `skillwiki memory index --project llm-wiki --if-stale`, then `skillwiki memory recall --project llm-wiki --topic session-brief --scope project --limit 5`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });

  it("accepts memory import command refs", () => {
    const text = "Run `skillwiki memory import --from /tmp/memories --project llm-wiki --dry-run --max-bytes 10000`.";
    expect(validateCliRefs(text, "test.md", surface)).toEqual([]);
  });
});
