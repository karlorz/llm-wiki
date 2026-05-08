import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTranscripts } from "../../src/commands/transcripts.js";

const TRANSCRIPT_FM = (ingested: string) => `---
source_url:
ingested: ${ingested}
sha256:
---

some transcript content`;

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

describe("runTranscripts", () => {
  it("lists transcript files", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-07-ad-hoc-captures.md"), TRANSCRIPT_FM("2026-05-07"));
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-06-meeting.md"), TRANSCRIPT_FM("2026-05-06"));
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(2);
      expect(r.result.data.transcripts[0].file).toBe("raw/transcripts/2026-05-06-meeting.md");
      expect(r.result.data.transcripts[1].file).toBe("raw/transcripts/2026-05-07-ad-hoc-captures.md");
    }
  });

  it("filters by --since date", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-07-ad-hoc-captures.md"), TRANSCRIPT_FM("2026-05-07"));
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-06-meeting.md"), TRANSCRIPT_FM("2026-05-06"));
    const r = await runTranscripts({ vault: dir, since: "2026-05-07" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(1);
      expect(r.result.data.transcripts[0].file).toBe("raw/transcripts/2026-05-07-ad-hoc-captures.md");
    }
  });

  it("returns empty list when no transcripts", async () => {
    const dir = makeVault();
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(0);
    }
  });

  it("returns VAULT_PATH_INVALID when raw/transcripts/ missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
    mkdirSync(join(dir, "concepts"), { recursive: true });
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
  });

  it("skips non-markdown files", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "notes.md"), TRANSCRIPT_FM("2026-05-07"));
    writeFileSync(join(dir, "raw", "transcripts", "image.png"), "not markdown");
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(1);
    }
  });

  it("filters transcripts by date prefix via --since", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "2026-04-28-old.md"), TRANSCRIPT_FM("2026-04-28"));
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-01-mid.md"), TRANSCRIPT_FM("2026-05-01"));
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-07-recent.md"), TRANSCRIPT_FM("2026-05-07"));
    const r = await runTranscripts({ vault: dir, since: "2026-05-01" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(2);
      expect(r.result.data.transcripts[0].file).toBe("raw/transcripts/2026-05-01-mid.md");
      expect(r.result.data.transcripts[1].file).toBe("raw/transcripts/2026-05-07-recent.md");
    }
  });

  it("returns empty list for vault with only SCHEMA.md", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
  });

  it("skips transcript with invalid frontmatter", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-07-bad.md"), `---
source_url:
ingested: 2026-05-07

no closing delimiter`);
    writeFileSync(join(dir, "raw", "transcripts", "2026-05-06-good.md"), TRANSCRIPT_FM("2026-05-06"));
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(1);
      expect(r.result.data.transcripts[0].file).toBe("raw/transcripts/2026-05-06-good.md");
    }
  });

  it("defaults ingested to empty string when non-string type", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "numeric.md"), `---
source_url:
ingested: 20260507
sha256:
---

numeric ingested`);
    const r = await runTranscripts({ vault: dir });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(1);
      expect(r.result.data.transcripts[0].ingested).toBe("");
    }
  });

  it("includes transcript with empty ingested when --since is set", async () => {
    const dir = makeVault();
    writeFileSync(join(dir, "raw", "transcripts", "no-date.md"), `---
source_url:
sha256:
---

no ingested date`);
    const r = await runTranscripts({ vault: dir, since: "2026-05-01" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.transcripts.length).toBe(1);
      expect(r.result.data.transcripts[0].ingested).toBe("");
    }
  });
});
