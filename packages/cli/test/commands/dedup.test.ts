import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDedup } from "../../src/commands/dedup.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "articles"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

function rawFile(hash: string, body: string) {
  return `---
type: raw
sha256: ${hash}
ingested: "2026-05-05"
---

${body}`;
}

describe("runDedup", () => {
  it("returns OK when no duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_B, "beta"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(0);
      expect(r.result.data.scanned).toBe(2);
    }
  });

  it("detects duplicate sha256 across files", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_A, "same body"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(33);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(1);
      expect(r.result.data.duplicates[0].files.length).toBe(2);
      expect(r.result.data.duplicates[0].sha256).toBe(HASH_A);
    }
  });

  it("skips raw files without valid sha256", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), `---
type: raw
ingested: "2026-05-05"
---

no hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });

  it("returns 9 for invalid vault", async () => {
    const r = await runDedup({ vault: "/nonexistent" });
    expect(r.exitCode).toBe(9);
  });

  it("reports multiple duplicate groups", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "x"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_A, "x"));
    writeFileSync(join(dir, "raw", "articles", "c.md"), rawFile(HASH_B, "y"));
    writeFileSync(join(dir, "raw", "articles", "d.md"), rawFile(HASH_B, "y"));
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(33);
    if (r.result.ok) {
      expect(r.result.data.duplicates.length).toBe(2);
    }
  });

  it("apply rewires citations and removes duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "concepts", "page.md"), `---
title: Test
type: concept
tags: [model]
sources:
  - "^[raw/articles/dup.md]"
---

Content citing duplicate.^[raw/articles/dup.md]
`);
    const r = await runDedup({ vault: dir, apply: true });
    expect(r.exitCode).toBe(36); // DEDUP_APPLIED
    if (r.result.ok) {
      expect(r.result.data.rewired).toContain("concepts/page.md");
      expect(r.result.data.removed).toContain("raw/articles/dup.md");
    }
    // Duplicate raw file deleted
    expect(existsSync(join(dir, "raw", "articles", "dup.md"))).toBe(false);
    // Canonical raw file preserved
    expect(existsSync(join(dir, "raw", "articles", "canonical.md"))).toBe(true);
    // Citations rewired
    const pageContent = readFileSync(join(dir, "concepts", "page.md"), "utf-8");
    expect(pageContent).toContain("^[raw/articles/canonical.md]");
    expect(pageContent).not.toContain("^[raw/articles/dup.md]");
  });

  it("apply keeps the stable shortest raw path instead of the first scanned duplicate", async () => {
    const dir = makeVault();
    const longName = "JayCRLMobileVC Turn your phone into the control center for an AI coding assistant CLI session.md";
    writeFileSync(join(dir, "raw", "articles", longName), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "JayCRLMobileVC.md"), rawFile(HASH_A, "same body"));

    const r = await runDedup({ vault: dir, apply: true });

    expect(r.exitCode).toBe(36);
    expect(existsSync(join(dir, "raw", "articles", "JayCRLMobileVC.md"))).toBe(true);
    expect(existsSync(join(dir, "raw", "articles", longName))).toBe(false);
    if (r.result.ok) {
      expect(r.result.data.removed).toContain(`raw/articles/${longName}`);
      expect(r.result.data.removed).not.toContain("raw/articles/JayCRLMobileVC.md");
    }
  });

  it("apply rewires citations in non-raw project pages", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));
    mkdirSync(join(dir, "projects", "llm-wiki", "history"), { recursive: true });
    writeFileSync(join(dir, "projects", "llm-wiki", "history", "note.md"), "Uses ^[raw/articles/dup.md]\n");

    const r = await runDedup({ vault: dir, apply: true });

    expect(readFileSync(join(dir, "projects", "llm-wiki", "history", "note.md"), "utf-8"))
      .toContain("^[raw/articles/canonical.md]");
    if (r.result.ok) {
      expect(r.result.data.rewired).toContain("projects/llm-wiki/history/note.md");
    }
  });

  it("apply skips unsafe same-sha groups with different raw bodies", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha body"));
    writeFileSync(join(dir, "raw", "articles", "b.md"), rawFile(HASH_A, "different body"));

    const r = await runDedup({ vault: dir, apply: true });

    expect(existsSync(join(dir, "raw", "articles", "a.md"))).toBe(true);
    expect(existsSync(join(dir, "raw", "articles", "b.md"))).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.removed).toEqual([]);
      expect(r.result.data.unsafe?.[0]?.reason).toBe("body_hash_mismatch");
      expect(r.result.data.unsafe?.[0]?.files).toEqual(["raw/articles/a.md", "raw/articles/b.md"]);
    }
  });

  it("apply writes a raw dedup manifest and plans remote deletes without executing them", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));
    const calls: string[][] = [];

    const r = await runDedup({
      vault: dir,
      apply: true,
      manifestOut: join(dir, ".skillwiki", "raw-dedup-manifest.json"),
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: false,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(dir, ".skillwiki", "raw-dedup-manifest.json"), "utf-8"));
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        sha256: HASH_A,
        canonical: "raw/articles/canonical.md",
        duplicates: ["raw/articles/dup.md"],
      }),
    ]);
    if (r.result.ok) {
      expect(r.result.data.remote?.plannedDeletes).toContain("seaweed-wiki:cloud/wiki/raw/articles/dup.md");
      expect(r.result.data.remote?.deleted).toEqual([]);
    }
  });

  it("remoteDelete executes bounded rclone deletefile commands for manifest duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));
    const calls: string[][] = [];

    const r = await runDedup({
      vault: dir,
      apply: true,
      remote: "seaweed-wiki:cloud/wiki/",
      remoteDelete: true,
      maxRemoteDeletes: 1,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(calls).toEqual([["deletefile", "seaweed-wiki:cloud/wiki/raw/articles/dup.md"]]);
    if (r.result.ok) {
      expect(r.result.data.remote?.deleted).toEqual(["seaweed-wiki:cloud/wiki/raw/articles/dup.md"]);
    }
  });

  it("remoteDelete refuses to exceed the remote delete cap before invoking rclone", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup-a.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup-b.md"), rawFile(HASH_A, "same body"));
    const calls: string[][] = [];

    const r = await runDedup({
      vault: dir,
      apply: true,
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: true,
      maxRemoteDeletes: 1,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(r.exitCode).not.toBe(0);
    expect(r.result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "raw", "articles", "dup-a.md"))).toBe(true);
    expect(existsSync(join(dir, "raw", "articles", "dup-b.md"))).toBe(true);
  });

  it("manifestIn can prune remote duplicates after local duplicates were already removed", async () => {
    const dir = makeVault();
    mkdirSync(join(dir, ".skillwiki"), { recursive: true });
    const manifestPath = join(dir, ".skillwiki", "raw-dedup-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      created_at: "2026-06-18T00:00:00.000Z",
      vault: dir,
      entries: [{
        sha256: HASH_A,
        bodyHash: HASH_B,
        canonical: "raw/articles/canonical.md",
        duplicates: ["raw/articles/dup.md"],
      }],
    }));
    const calls: string[][] = [];

    const r = await runDedup({
      vault: dir,
      manifestIn: manifestPath,
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: true,
      maxRemoteDeletes: 1,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(r.exitCode).toBe(0);
    expect(calls).toEqual([["deletefile", "seaweed-wiki:cloud/wiki/raw/articles/dup.md"]]);
    if (r.result.ok) {
      expect(r.result.data.remote?.deleted).toEqual(["seaweed-wiki:cloud/wiki/raw/articles/dup.md"]);
    }
  });

  it("remoteDelete requires apply or manifestIn before deleting remote objects", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));
    const calls: string[][] = [];

    const r = await runDedup({
      vault: dir,
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: true,
      rcloneRunner: async args => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(r.exitCode).toBe(46);
    expect(r.result.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "raw", "articles", "dup.md"))).toBe(true);
  });

  it("remoteDelete returns sync push failure when rclone deletefile fails", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));

    const r = await runDedup({
      vault: dir,
      apply: true,
      remote: "seaweed-wiki:cloud/wiki",
      remoteDelete: true,
      maxRemoteDeletes: 1,
      rcloneRunner: async () => ({ exitCode: 1, stdout: "", stderr: "delete failed" }),
    });

    expect(r.exitCode).toBe(42);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.error).toBe("SYNC_PUSH_FAILED");
    }
    expect(existsSync(join(dir, "raw", "articles", "dup.md"))).toBe(true);
  });

  it("remoteDelete requires a remote root", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "canonical.md"), rawFile(HASH_A, "same body"));
    writeFileSync(join(dir, "raw", "articles", "dup.md"), rawFile(HASH_A, "same body"));

    const r = await runDedup({ vault: dir, apply: true, remoteDelete: true });

    expect(r.exitCode).not.toBe(0);
    expect(r.result.ok).toBe(false);
    expect(existsSync(join(dir, "raw", "articles", "dup.md"))).toBe(true);
  });

  it("apply exits OK when no duplicates", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    const r = await runDedup({ vault: dir, apply: true });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.rewired).toEqual([]);
      expect(r.result.data.removed).toEqual([]);
    }
  });

  it("skips raw file with sha256 of wrong length", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "short.md"), `---
type: raw
sha256: abc123
ingested: "2026-05-05"
---

short hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });

  it("skips raw file where sha256 is not a string type", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "articles", "a.md"), rawFile(HASH_A, "alpha"));
    writeFileSync(join(dir, "raw", "articles", "numeric.md"), `---
type: raw
sha256: 999
ingested: "2026-05-05"
---

numeric hash`);
    const r = await runDedup({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.scanned).toBe(1);
      expect(r.result.data.duplicates.length).toBe(0);
    }
  });
});
