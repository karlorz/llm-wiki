import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLastOp, readLastOp, clearLastOp } from "../../src/utils/last-op.js";

describe("last-op", () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true }); } catch {} });

  function makeVault(): string {
    dir = mkdtempSync(join(tmpdir(), "lastop-test-"));
    return dir;
  }

  it("readLastOp returns empty array when no file exists", () => {
    const vault = makeVault();
    const ops = readLastOp(vault);
    expect(ops).toEqual([]);
  });

  it("appendLastOp creates file and can be read back", () => {
    const vault = makeVault();
    appendLastOp(vault, { operation: "ingest", summary: "added foo", files: ["raw/articles/foo.md"], timestamp: "2026-05-09T04:00:00Z" });
    const ops = readLastOp(vault);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operation: "ingest", summary: "added foo", files: ["raw/articles/foo.md"] });
  });

  it("appendLastOp appends to existing entries", () => {
    const vault = makeVault();
    appendLastOp(vault, { operation: "ingest", summary: "added foo", files: ["raw/articles/foo.md"], timestamp: "2026-05-09T04:00:00Z" });
    appendLastOp(vault, { operation: "archive", summary: "moved bar", files: ["concepts/bar.md"], timestamp: "2026-05-09T04:01:00Z" });
    const ops = readLastOp(vault);
    expect(ops).toHaveLength(2);
    expect(ops[0].operation).toBe("ingest");
    expect(ops[1].operation).toBe("archive");
  });

  it("clearLastOp deletes the file", () => {
    const vault = makeVault();
    appendLastOp(vault, { operation: "ingest", summary: "added foo", files: ["raw/articles/foo.md"], timestamp: "2026-05-09T04:00:00Z" });
    clearLastOp(vault);
    expect(existsSync(join(vault, ".skillwiki", "last-op.json"))).toBe(false);
    expect(readLastOp(vault)).toEqual([]);
  });

  it("readLastOp handles corrupted JSON by returning empty and deleting file", () => {
    const vault = makeVault();
    const skillwikiDir = join(vault, ".skillwiki");
    mkdirSync(skillwikiDir, { recursive: true });
    writeFileSync(join(skillwikiDir, "last-op.json"), "NOT VALID JSON{{{{", "utf8");
    const ops = readLastOp(vault);
    expect(ops).toEqual([]);
    expect(existsSync(join(skillwikiDir, "last-op.json"))).toBe(false);
  });

  it("readLastOp handles non-array JSON by returning empty and deleting file", () => {
    const vault = makeVault();
    const skillwikiDir = join(vault, ".skillwiki");
    mkdirSync(skillwikiDir, { recursive: true });
    writeFileSync(join(skillwikiDir, "last-op.json"), '{"wrong": true}', "utf8");
    const ops = readLastOp(vault);
    expect(ops).toEqual([]);
  });
});
