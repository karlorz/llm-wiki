import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

  it("--apply updates sha256 in drifted source", async () => {
    const dir = makeVault();
    const srcPath = join(dir, "raw", "articles", "src.md");
    writeFileSync(srcPath, RAW_FM_TEMPLATE("https://example.com/a", STORED_HASH));
    const newBody = "changed content here";
    const r = await runDrift({
      vault: dir,
      apply: true,
      fetchFn: async () => ok({ body: newBody }),
    });
    // Exit 0 because drift was fixed via --apply
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.updated.length).toBe(1);
      expect(r.result.data.updated[0].status).toBe("updated");
    }
    // Verify file was updated with new sha256
    const updated = readFileSync(srcPath, "utf8");
    expect(updated).toMatch(/^sha256: [a-f0-9]{64}$/m);
    expect(updated).not.toContain(STORED_HASH);
  });

  it("--apply does not modify unchanged sources", async () => {
    const dir = makeVault();
    const matchingHash = "d8c281f1829771acffd8bf707720f0aed9f0c22c9c4aac2f34e06413044a0043";
    const srcPath = join(dir, "raw", "articles", "src.md");
    writeFileSync(srcPath, RAW_FM_TEMPLATE("https://example.com/a", matchingHash));
    const r = await runDrift({
      vault: dir,
      apply: true,
      fetchFn: async () => ok({ body: "body content here" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.updated.length).toBe(0);
      expect(r.result.data.unchanged).toBe(1);
    }
  });

  it("reports identity_conflicts when fetched drift body disagrees with raw filename", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "hermes-llm-wiki-SKILL-v2.1.0.md"), RAW_FM_TEMPLATE(
      "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      STORED_HASH
    ));

    const r = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "# Superpowers\n\nSuperpowers is a complete software development methodology." }),
    });

    expect(r.exitCode).toBe(32);
    if (r.result.ok) {
      expect(r.result.data.identity_conflicts.length).toBe(1);
      expect(r.result.data.identity_conflicts[0].raw_path).toBe("raw/articles/hermes-llm-wiki-SKILL-v2.1.0.md");
      expect(r.result.data.drifted.length).toBe(0);
    }
  });

  it("--apply does not update sha256 for identity-conflicted sources", async () => {
    const dir = makeVault();
    const srcPath = join(dir, "raw", "articles", "hermes-llm-wiki-SKILL-v2.1.0.md");
    writeFileSync(srcPath, RAW_FM_TEMPLATE(
      "https://raw.githubusercontent.com/obra/superpowers/main/README.md",
      STORED_HASH
    ));

    const r = await runDrift({
      vault: dir,
      apply: true,
      fetchFn: async () => ok({ body: "# Superpowers\n\nSuperpowers is a complete software development methodology." }),
    });

    expect(r.exitCode).toBe(32);
    if (r.result.ok) {
      expect(r.result.data.identity_conflicts.length).toBe(1);
      expect(r.result.data.updated.length).toBe(0);
    }
    expect(readFileSync(srcPath, "utf8")).toContain(`sha256: ${STORED_HASH}`);
  });

  it("--new lists raw files ingested on/after given date", async () => {
    const dir = makeVault();
    mkdirSync(join(dir, "raw", "transcripts"), { recursive: true });
    writeFileSync(join(dir, "raw", "transcripts", "new.md"), `---
source_url:
ingested: "2026-05-07"
sha256:
---

new capture`);
    writeFileSync(join(dir, "raw", "articles", "old.md"), `---
source_url:
ingested: "2026-05-05"
sha256:
---

old article`);
    const r = await runDrift({ vault: dir, newSince: "2026-05-07" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.newFiles.length).toBe(1);
      expect(r.result.data.newFiles[0].raw_path).toBe("raw/transcripts/new.md");
      expect(r.result.data.newFiles[0].ingested).toBe("2026-05-07");
    }
  });

  it("skips source_url without http/https scheme", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "internal.md"), `---
source_url: plan:2026-05-02-llm-wiki-skill
sha256: ${STORED_HASH}
ingested: "2026-05-02"
---

vault-internal plan`);
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => err("FETCH_FAILED", { message: "should not be called" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.fetch_failed.length).toBe(0);
      expect(r.result.data.scanned).toBe(0);
    }
  });

  it("--new with no matching files returns empty list", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "old.md"), `---
source_url:
ingested: "2026-05-01"
sha256:
---

old`);
    const r = await runDrift({ vault: dir, newSince: "2026-05-07" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.newFiles.length).toBe(0);
    }
  });

  it("--new parses unquoted YAML ingested date", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "unquoted.md"), `---
source_url:
ingested: 2026-05-07
sha256:
---

unquoted date`);
    const r = await runDrift({ vault: dir, newSince: "2026-05-07" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.newFiles.length).toBe(1);
      expect(r.result.data.newFiles[0].ingested).toBe("2026-05-07");
    }
  });

  it("--new parses single-quoted YAML ingested date", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "single.md"), `---
source_url:
ingested: '2026-05-07'
sha256:
---

single-quoted date`);
    const r = await runDrift({ vault: dir, newSince: "2026-05-07" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.newFiles.length).toBe(1);
      expect(r.result.data.newFiles[0].ingested).toBe("2026-05-07");
    }
  });

  it("skips files with refreshable: false", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "nonrefresh.md"), `---
sha256: ${STORED_HASH}
source_url: https://example.com/a
ingested: "2026-05-05"
refreshable: false
---

body content here`);
    const r = await runDrift({
      vault: dir,
      fetchFn: async () => ok({ body: "changed content here" }),
    });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(0);
      expect(r.result.data.drifted.length).toBe(0);
    }
  });
});
