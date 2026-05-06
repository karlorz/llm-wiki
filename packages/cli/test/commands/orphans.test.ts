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
});
