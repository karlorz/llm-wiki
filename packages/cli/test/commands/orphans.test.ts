import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrphans } from "../../src/commands/orphans.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("orphans", () => {
  it("flags zero-degree pages as orphans", async () => {
    const r = await runOrphans({ vault: VAULT });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(Array.isArray(r.result.data.orphans)).toBe(true);
      expect(Array.isArray(r.result.data.bridges)).toBe(true);
    }
  });

  it("resolves full-path wikilinks over filename-only collisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orphan-col-"));
    mkdirSync(join(dir, "entities"), { recursive: true });
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# schema\n");
    writeFileSync(join(dir, "entities", "shared-name.md"), "---\ntitle: E\n---\n## Overview\n\nSee [[concepts/shared-name]].\n");
    writeFileSync(join(dir, "concepts", "shared-name.md"), "---\ntitle: C\n---\n## Overview\n\nSee [[entities/shared-name]].\n");
    const r = await runOrphans({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.orphans).toEqual([]);
    }
  });
});

describe("orphans (vault-optional)", () => {
  it("uses --vault when provided", async () => {
    const r = await runOrphans({ vault: VAULT });
    expect(r.exitCode).toBe(0);
  });

  it("returns NO_VAULT_CONFIGURED (25) when neither --vault nor env nor dotenv supply a vault", async () => {
    const h = mkdtempSync(join(tmpdir(), "no-vault-"));
    mkdirSync(join(h, ".skillwiki"), { recursive: true });
    const r = await runOrphans({ vault: undefined, envValue: undefined, home: h });
    expect(r.exitCode).toBe(25);
  });

  it("returns UNKNOWN_WIKI_PROFILE (35) when wiki profile name is not found in dotenv", async () => {
    const h = mkdtempSync(join(tmpdir(), "no-profile-"));
    mkdirSync(join(h, ".skillwiki"), { recursive: true });
    const r = await runOrphans({ vault: undefined, envValue: undefined, home: h, wiki: "nonexistent" });
    expect(r.exitCode).toBe(35);
    if (!r.result.ok) {
      expect(r.result.error).toBe("UNKNOWN_WIKI_PROFILE");
    }
  });
});

describe("orphans (graph-edge cases)", () => {
  it("returns empty for fully-connected vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orphan-conn-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# schema\n");
    writeFileSync(join(dir, "concepts", "alpha.md"), "---\ntitle: A\n---\n## Overview\n\nSee [[beta]].\n");
    writeFileSync(join(dir, "concepts", "beta.md"), "---\ntitle: B\n---\n## Overview\n\nSee [[alpha]].\n");
    const r = await runOrphans({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.orphans).toEqual([]);
    }
  });

  it("handles vault with no wikilinks at all — all pages are orphans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orphan-none-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# schema\n");
    writeFileSync(join(dir, "concepts", "alpha.md"), "---\ntitle: A\n---\n## Overview\n\nStandalone page.\n");
    writeFileSync(join(dir, "concepts", "beta.md"), "---\ntitle: B\n---\n## Overview\n\nAnother standalone.\n");
    const r = await runOrphans({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.orphans.length).toBe(2);
    }
  });

  it("detects bridge nodes whose removal disconnects the graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orphan-bridge-"));
    mkdirSync(join(dir, "concepts"), { recursive: true });
    writeFileSync(join(dir, "SCHEMA.md"), "# schema\n");
    writeFileSync(join(dir, "concepts", "alpha.md"), "---\ntitle: Alpha\n---\n## Overview\n\nSee [[bravo]].\n");
    writeFileSync(join(dir, "concepts", "bravo.md"), "---\ntitle: Bravo\n---\n## Overview\n\nSee [[alpha]] and [[charlie]].\n");
    writeFileSync(join(dir, "concepts", "charlie.md"), "---\ntitle: Charlie\n---\n## Overview\n\nSee [[bravo]].\n");
    const r = await runOrphans({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.orphans).toEqual([]);
      expect(r.result.data.bridges.length).toBeGreaterThanOrEqual(1);
      expect(r.result.data.bridges.some(b => b.path === "concepts/bravo.md")).toBe(true);
    }
  });
});

describe("orphans (invalid vault)", () => {
  it("returns VAULT_PATH_INVALID (9) when given vault path does not exist", async () => {
    const r = await runOrphans({ vault: "/nonexistent/vault/paththatdoesnotexist42" });
    expect(r.exitCode).toBe(9);
  });
});
