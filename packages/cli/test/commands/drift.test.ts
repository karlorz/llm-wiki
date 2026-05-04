import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrift } from "../../src/commands/drift.js";
import { ok, err } from "@skillwiki/shared";

const RAW_FM_TEMPLATE = (url: string, hash: string) => `---
sha256: ${hash}
source_url: ${url}
ingested: "2026-05-05"
ingested_by: wiki-ingest
---

body content here`;

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

const STORED_HASH = "a".repeat(64);
const CHANGED_HASH = "b".repeat(64);

describe("runDrift", () => {
  it("no drift when sha256 matches", async () => {
    const dir = makeVault();
    // Use the actual sha256 of the mock fetch body
    const matchingHash = "d8c281f1829771acffd8bf707720f0aed9f0c22c9c4aac2f34e06413044a0043";
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", matchingHash));
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "body content here" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.unchanged).toBe(1);
      expect(r.result.data.drifted.length).toBe(0);
    }
  });

  it("detects drift when sha256 differs", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "changed content here" }),
    });
    expect(r.exitCode).toBe(32);
    if (r.result.ok) {
      expect(r.result.data.drifted.length).toBe(1);
      expect(r.result.data.drifted[0].current_sha256).not.toBe(STORED_HASH);
    }
  });

  it("reports fetch_failed when URL unreachable", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "src.md"), RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => err("FETCH_FAILED", { message: "timeout" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fetch_failed.length).toBe(1);
    }
  });

  it("scans 0 when no raw sources have source_url", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "nourl.md"), `---
sha256: ${STORED_HASH}
ingested: "2026-05-05"
ingested_by: wiki-ingest
---

body`);
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(0);
    }
  });

  it("returns 9 for invalid vault", async () => {
    const r = await runDrift({ vault: "/nonexistent" });
    expect(r.exitCode).toBe(9);
  });
});
