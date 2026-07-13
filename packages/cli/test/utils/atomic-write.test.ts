import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText } from "../../src/utils/atomic-write.js";

describe("atomicWriteText", () => {
  it("publishes exact bytes and leaves no temp file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-text-"));
    const target = join(dir, "SCHEMA.md");

    const result = await atomicWriteText(target, "next\n");

    expect(result).toEqual({ ok: true, data: { changed: true, existed: false } });
    expect(readFileSync(target, "utf8")).toBe("next\n");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not change mtime for byte-identical content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-text-"));
    const target = join(dir, "index.md");
    writeFileSync(target, "same\n");
    const before = statSync(target).mtimeMs;

    const result = await atomicWriteText(target, "same\n");

    expect(result).toEqual({ ok: true, data: { changed: false, existed: true } });
    expect(statSync(target).mtimeMs).toBe(before);
  });
});
