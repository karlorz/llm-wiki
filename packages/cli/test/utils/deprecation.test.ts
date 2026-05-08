import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDeprecatedWarnings } from "../../src/utils/deprecation.js";

function homeDir(): string {
  return mkdtempSync(join(tmpdir(), "deprecation-home-"));
}

// Track temp dirs for cleanup
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* OS cleans up */ }
  }
});

describe("getDeprecatedWarnings", () => {
  it("returns empty array when no manifest exists", () => {
    const h = homeDir();
    tmpDirs.push(h);
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toEqual([]);
  });

  it("returns empty array when manifest has no skills field", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), JSON.stringify({ installed: [], backed_up: [] }));
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toEqual([]);
  });

  it("returns empty array when no skills are deprecated", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), JSON.stringify({
      installed: [],
      backed_up: [],
      skills: {
        "wiki-init": { name: "wiki-init", version: "0.2.1" },
        "proj-work": { name: "proj-work", version: "0.2.1" },
      },
    }));
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toEqual([]);
  });

  it("returns warning for each deprecated skill", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), JSON.stringify({
      installed: [],
      backed_up: [],
      skills: {
        "wiki-init": { name: "wiki-init", version: "0.2.1" },
        "wiki-old": { name: "wiki-old", version: "0.1.0", deprecated: true },
        "proj-decide": { name: "proj-decide", version: "0.2.1", deprecated: true },
      },
    }));
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('wiki-old');
    expect(warnings[0]).toContain('deprecated');
    expect(warnings[1]).toContain('proj-decide');
    expect(warnings[1]).toContain('deprecated');
  });

  it("uses directory name when skill meta has no name field", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), JSON.stringify({
      installed: [],
      backed_up: [],
      skills: {
        "wiki-unnamed": { version: "0.1.0", deprecated: true },
      },
    }));
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("wiki-unnamed");
  });

  it("includes the deprecation marker symbol in warning text", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), JSON.stringify({
      installed: [],
      backed_up: [],
      skills: {
        "wiki-old": { name: "wiki-old", deprecated: true },
      },
    }));
    const warnings = getDeprecatedWarnings(h);
    expect(warnings[0]).toMatch(/^⚠ /);
    expect(warnings[0]).toContain("See SKILL.md for migration notes");
  });

  it("handles invalid JSON in manifest gracefully", () => {
    const h = homeDir();
    tmpDirs.push(h);
    mkdirSync(join(h, ".claude", "skills"), { recursive: true });
    writeFileSync(join(h, ".claude", "skills", "wiki-manifest.json"), "not valid json {{{");
    const warnings = getDeprecatedWarnings(h);
    expect(warnings).toEqual([]);
  });
});
