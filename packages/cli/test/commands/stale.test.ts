import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStale } from "../../src/commands/stale.js";

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(v, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(v, "projects"), { recursive: true });
  return v;
}

const TRANSCRIPT_FM = `---
title: idea
type: transcript
ingested: "2026-04-01"
---

capture text`;

const DONE_SPEC = `---
title: done item
status: done
---

spec body`;

const INCOMPLETE_SPEC = `---
title: incomplete item
---

spec body`;

describe("runStale", () => {
  it("flags transcript when matching work item is done", async () => {
    const v = makeVault();
    writeFileSync(join(v, "raw", "transcripts", "2026-04-01-idea-foo.md"), TRANSCRIPT_FM);
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-foo");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), DONE_SPEC);
    const r = await runStale({ vault: v, days: 3 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.stale_transcripts.length).toBe(1);
      expect(r.result.data.stale_transcripts[0].path).toBe("raw/transcripts/2026-04-01-idea-foo.md");
      expect(r.result.data.stale_transcripts[0].reason).toContain("done");
    }
  });

  it("flags incomplete work item older than days with spec but no plan", async () => {
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-old");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), INCOMPLETE_SPEC);
    const r = await runStale({ vault: v, days: 3 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.incomplete_work_items.length).toBe(1);
      expect(r.result.data.incomplete_work_items[0].reason).toContain("no plan");
    }
  });

  it("flags work item with only work-item.md older than days", async () => {
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-stale");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "work-item.md"), `---\ntitle: wi\n---\n\nbare`);
    const r = await runStale({ vault: v, days: 3 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.incomplete_work_items.length).toBe(1);
      expect(r.result.data.incomplete_work_items[0].reason).toContain("work-item.md");
    }
  });

  it("does not flag fresh work items", async () => {
    const v = makeVault();
    const today = new Date().toISOString().slice(0, 10);
    const workDir = join(v, "projects", "acme", "work", `${today}-fresh`);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---\ntitle: fresh\n---\n\nbody`);
    const r = await runStale({ vault: v, days: 3 });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.incomplete_work_items.length).toBe(0);
    }
  });

  it("does not flag complete work items (has both spec and plan)", async () => {
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-complete");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---\ntitle: c\n---\n\nspec`);
    writeFileSync(join(workDir, "plan.md"), `---\ntitle: c\n---\n\nplan`);
    const r = await runStale({ vault: v, days: 3 });
    if (r.result.ok) {
      expect(r.result.data.incomplete_work_items.length).toBe(0);
    }
  });

  it("returns exit code 9 for invalid vault", async () => {
    const r = await runStale({ vault: "/nonexistent", days: 3 });
    expect(r.exitCode).toBe(9);
  });

  it("flags done work items that should be archived", async () => {
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-done-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), DONE_SPEC);
    writeFileSync(join(workDir, "plan.md"), `---\ntitle: plan\n---\n\nplan body`);
    const r = await runStale({ vault: v, days: 3 });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      expect(r.result.data.done_work_items.length).toBe(1);
      expect(r.result.data.done_work_items[0].reason).toContain("completed");
    }
  });

  it("flags invalid work items that should be archived", async () => {
    const v = makeVault();
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-invalid-item");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), `---\ntitle: invalid item\nstatus: invalid\n---\n\nspec body`);
    const r = runStale({ vault: v, days: 3 });
    const result = await r;
    expect(result.exitCode).toBe(19);
    if (result.result.ok) {
      expect(result.result.data.done_work_items.length).toBe(1);
      expect(result.result.data.done_work_items[0].reason).toContain("invalid");
    }
  });

  it("--archive skips raw files cited by typed-knowledge pages (N9 protection)", async () => {
    const v = makeVault();
    mkdirSync(join(v, "concepts"), { recursive: true });
    const transcriptPath = join(v, "raw", "transcripts", "2026-04-01-cited.md");
    writeFileSync(transcriptPath, TRANSCRIPT_FM);
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-cited");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), DONE_SPEC);
    // Typed-knowledge page cites the raw transcript — N9: raw is immutable
    writeFileSync(join(v, "concepts", "cites-raw.md"), `---\ntitle: cites\nsources: [raw/transcripts/2026-04-01-cited.md]\n---\n\nSome prose ^[raw/transcripts/2026-04-01-cited.md]\n`);
    const result = await runStale({ vault: v, days: 3, archive: true });
    if (result.result.ok) {
      // Transcript should NOT be archived because it is cited
      expect(result.result.data.archived).not.toContain("raw/transcripts/2026-04-01-cited.md");
      expect(existsSync(transcriptPath)).toBe(true);
    }
  });

  it("--archive moves stale items to _archive", async () => {
    const v = makeVault();
    const transcriptPath = join(v, "raw", "transcripts", "2026-04-01-idea-arch.md");
    writeFileSync(transcriptPath, TRANSCRIPT_FM);
    const workDir = join(v, "projects", "acme", "work", "2026-04-01-arch");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "spec.md"), DONE_SPEC);
    const r = await runStale({ vault: v, days: 3, archive: true });
    expect(r.exitCode).toBe(19);
    if (r.result.ok) {
      // Transcript archived to _archive, done work item archived to history
      expect(r.result.data.archived.length).toBe(2);
      expect(existsSync(transcriptPath)).toBe(false);
      expect(existsSync(workDir)).toBe(false);
    }
  });
});
