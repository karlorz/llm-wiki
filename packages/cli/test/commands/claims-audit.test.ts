import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runClaimsAudit } from "../../src/commands/claims-audit.js";
import { REDACTED_MALFORMED_REFERENCE } from "../../src/utils/transcript-claims.js";

/**
 * Task 2: read-only `claims audit` command integration tests.
 *
 * Every finding category gets a temporary vault fixture, plus one clean
 * fixture. A no-mutation test asserts a precomputed absolute-file digest map
 * is unchanged and no operation/projection artifacts are produced.
 */

function makeVault(): string {
  const v = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(v, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(v, "projects"), { recursive: true });
  return v;
}

function writeTranscript(vault: string, name: string, frontmatter: Record<string, string>): void {
  const lines = ["---", ...Object.entries(frontmatter).map(([k, val]) => `${k}: ${val}`), "---", "", "body"];
  writeFileSync(join(vault, "raw", "transcripts", name), lines.join("\n"));
}

function writeSpec(vault: string, project: string, item: string, frontmatter: Record<string, string>): void {
  const dir = join(vault, "projects", project, "work", item);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", ...Object.entries(frontmatter).map(([k, val]) => `${k}: ${val}`), "---", "", "spec body"];
  writeFileSync(join(dir, "spec.md"), lines.join("\n"));
}

/** Recursively map every file under a vault to its absolute path + SHA-256. */
function snapshotTree(root: string): Map<string, string> {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out.set(abs, createHash("sha256").update(readFileSync(abs)).digest("hex"));
      }
    }
  };
  walk(root);
  return out;
}

/** Absolute locations where a mutating command would write artifacts. */
const NO_WRITE_PATHS = [
  ".skillwiki",
  "meta/log-events",
  "meta/last-op.md",
  "meta/latest-session-brief.md",
  ".git",
];

function expectNoWriteArtifacts(vault: string): void {
  for (const p of NO_WRITE_PATHS) {
    try {
      readdirSync(join(vault, p));
      expect(`unexpected artifact present: ${p}`).toBe("");
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      expect(e.code).toBe("ENOENT");
    }
  }
}

describe("skillwiki claims audit", () => {
  it("returns NO findings for a clean fixture", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-01-task-ok.md", {
      source_url: "", ingested: "2026-05-01", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-01-ok", {
      source: "raw/transcripts/2026-05-01-task-ok.md",
    });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    expect(r.result.data.findings).toEqual([]);
    expect(r.result.data.summary).toEqual({
      duplicate_claim: 0,
      malformed_claim_reference: 0,
      dangling_claim_reference: 0,
      project_mismatch: 0,
      work_item_unbacked_claim: 0,
    });
  });

  it("does NOT mutate the vault and writes no operation/projection artifacts", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-01-task-ok.md", {
      source_url: "", ingested: "2026-05-01", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-01-ok", {
      source: "raw/transcripts/2026-05-01-task-ok.md",
    });
    const before = snapshotTree(v);
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    const after = snapshotTree(v);
    expect(after).toEqual(before);
    expectNoWriteArtifacts(v);
  });

  it("reports duplicate_claim when two work items claim the same transcript", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-02-task-dedup.md", {
      source_url: "", ingested: "2026-05-02", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-02-a", { source: "raw/transcripts/2026-05-02-task-dedup.md" });
    writeSpec(v, "acme", "2026-05-02-b", { source: "raw/transcripts/2026-05-02-task-dedup.md" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const dup = r.result.data.findings.filter((f) => f.kind === "duplicate_claim");
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({
      path: "raw/transcripts/2026-05-02-task-dedup.md",
      owners: ["projects/acme/work/2026-05-02-a", "projects/acme/work/2026-05-02-b"],
    });
    expect(r.result.data.summary.duplicate_claim).toBe(1);
  });

  it("reports malformed_claim_reference for noncanonical attempted raw-transcript refs", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-03-task-malformed.md", {
      source_url: "", ingested: "2026-05-03", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-03-bad", { source: "raw/transcripts/2026-05-03-writing.txt" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const mal = r.result.data.findings.filter((f) => f.kind === "malformed_claim_reference");
    expect(mal).toHaveLength(1);
    expect(mal[0]).toMatchObject({
      relDir: "projects/acme/work/2026-05-03-bad",
      field: "source",
      value: "raw/transcripts/2026-05-03-writing.txt",
    });
    expect(r.result.data.summary.malformed_claim_reference).toBe(1);
  });

  it("redacts a malformed_claim_reference whose value embeds body-like content", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-03-task-secret.md", {
      source_url: "", ingested: "2026-05-03", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    // source: is a literal block scalar; js-yaml reconstructs it as a string
    // with an embedded newline carrying a secret-like trailing line.
    const dir = join(v, "projects", "acme", "work", "2026-05-03-secret");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "spec.md"),
      "---\nsource: |-\n  raw/transcripts/2026-05-03-writing.txt\n  api_key=supersecretvalue\n---\n\nspec body\n",
    );
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const mal = r.result.data.findings.filter((f) => f.kind === "malformed_claim_reference");
    expect(mal).toHaveLength(1);
    expect(mal[0]).toMatchObject({
      relDir: "projects/acme/work/2026-05-03-secret",
      field: "source",
      value: REDACTED_MALFORMED_REFERENCE,
    });
    // The raw secret never reaches the audit result or the human hint.
    expect(JSON.stringify(r.result.data)).not.toContain("supersecretvalue");
    expect(JSON.stringify(r.result.data)).not.toContain("api_key=");
    expect(r.result.data.humanHint).not.toContain("\n");
    const secretLine = r.result.data.humanHint.split("\n").find((l) => l.includes("malformed_claim_reference"));
    expect(secretLine).toBe("malformed_claim_reference: projects/acme/work/2026-05-03-secret source=[redacted]");
    expect(r.result.data.summary.malformed_claim_reference).toBe(1);
  });

  it("never turns a multiline block scalar ending in .md into a claim or leaks it to output", async () => {
    const v = makeVault();
    // A distinct real transcript exists; the leaked path below must never match it.
    writeTranscript(v, "2026-05-11-task-real.md", {
      source_url: "", ingested: "2026-05-11", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    // Literal block scalar whose reconstructed first line is a valid-looking
    // raw/transcripts/...md claim but whose trailing line ends in .md too, so a
    // naive prefix+suffix check accepts it as a claimed path and leaks it.
    const dir = join(v, "projects", "acme", "work", "2026-05-11-secret");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "spec.md"),
      "---\nsource: |-\n  raw/transcripts/2026-05-11-task-secret.md\n  password=hunter2.md\n---\n\nspec body\n",
    );
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const findingJson = JSON.stringify(r.result.data.findings);
    expect(findingJson).not.toContain("hunter2");
    expect(findingJson).not.toContain("password=");
    expect(r.result.data.humanHint).not.toContain("hunter2");
    expect(r.result.data.humanHint).not.toContain("password=");
    expect(r.result.data.humanHint).not.toContain("\n");
    // It must surface only as a redacted malformed reference, never any claim kind.
    const mal = r.result.data.findings.filter((f) => f.kind === "malformed_claim_reference");
    expect(mal).toHaveLength(1);
    expect(mal[0]).toMatchObject({
      relDir: "projects/acme/work/2026-05-11-secret",
      field: "source",
      value: REDACTED_MALFORMED_REFERENCE,
    });
    expect(
      r.result.data.findings.some(
        (f) => f.kind === "dangling_claim_reference" || f.kind === "project_mismatch",
      ),
    ).toBe(false);
    expect(r.result.data.summary.malformed_claim_reference).toBe(1);
    expect(r.result.data.summary.dangling_claim_reference).toBe(0);
    expect(r.result.data.summary.project_mismatch).toBe(0);
  });

  it("reports dangling_claim_reference for a canonical claimed path missing from active transcripts", async () => {
    const v = makeVault();
    // Claim references a transcript that does not exist on disk.
    writeSpec(v, "acme", "2026-05-04-dang", { source: "raw/transcripts/2026-05-04-missing.md" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const dang = r.result.data.findings.filter((f) => f.kind === "dangling_claim_reference");
    expect(dang).toHaveLength(1);
    expect(dang[0]).toMatchObject({
      path: "raw/transcripts/2026-05-04-missing.md",
      claimedBy: "projects/acme/work/2026-05-04-dang",
    });
    expect(r.result.data.summary.dangling_claim_reference).toBe(1);
  });

  it("reports project_mismatch when a capture with explicit project is claimed by another project", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-05-task-cross.md", {
      source_url: "", ingested: "2026-05-05", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    // Claimed by a work item under project "beta".
    writeSpec(v, "beta", "2026-05-05-cross", { source: "raw/transcripts/2026-05-05-task-cross.md" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const mis = r.result.data.findings.filter((f) => f.kind === "project_mismatch");
    expect(mis).toHaveLength(1);
    expect(mis[0]).toMatchObject({
      path: "raw/transcripts/2026-05-05-task-cross.md",
      captureProject: "acme",
      claimedByProject: "beta",
      claimedBy: "projects/beta/work/2026-05-05-cross",
    });
    expect(r.result.data.summary.project_mismatch).toBe(1);
  });

  it("under --project acme reports an acme work item claiming an explicitly beta transcript as project_mismatch", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-10-cross-owned.md", {
      source_url: "", ingested: "2026-05-10", sha256: "0".repeat(64),
      project: '"[[beta]]"', kind: "task",
    });
    // An acme-scoped work item claims a transcript explicitly owned by beta.
    writeSpec(v, "acme", "2026-05-10-cross-claimed", {
      source: "raw/transcripts/2026-05-10-cross-owned.md",
    });
    const r = await runClaimsAudit({ vault: v, project: "acme" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const mis = r.result.data.findings.filter((f) => f.kind === "project_mismatch");
    expect(mis).toHaveLength(1);
    expect(mis[0]).toMatchObject({
      path: "raw/transcripts/2026-05-10-cross-owned.md",
      captureProject: "beta",
      claimedByProject: "acme",
      claimedBy: "projects/acme/work/2026-05-10-cross-claimed",
    });
    expect(r.result.data.summary.project_mismatch).toBe(1);
  });

  it("does NOT report project_mismatch when capture project matches claiming project", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-09-task-exact.md", {
      source_url: "", ingested: "2026-05-09", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-09-exact", { source: "raw/transcripts/2026-05-09-task-exact.md" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    expect(r.result.data.findings.filter((f) => f.kind === "project_mismatch")).toEqual([]);
  });

  it("reports work_item_unbacked_claim for a transcript with work_item but no exact claim", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-06-task-unbacked.md", {
      source_url: "", ingested: "2026-05-06", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
      work_item: '"[[2026-05-06-task-unbacked]]"',
    });
    // No work item claims this transcript.
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    const un = r.result.data.findings.filter((f) => f.kind === "work_item_unbacked_claim");
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({
      path: "raw/transcripts/2026-05-06-task-unbacked.md",
      workItem: "[[2026-05-06-task-unbacked]]",
    });
    expect(r.result.data.summary.work_item_unbacked_claim).toBe(1);
  });

  it("does NOT report work_item_unbacked_claim when the transcript has an exact claim", async () => {
    const v = makeVault();
    writeTranscript(v, "2026-05-07-task-backed.md", {
      source_url: "", ingested: "2026-05-07", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
      work_item: '"[[2026-05-07-task-backed]]"',
    });
    writeSpec(v, "acme", "2026-05-07-backed", { source: "raw/transcripts/2026-05-07-task-backed.md" });
    const r = await runClaimsAudit({ vault: v });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    expect(r.result.data.findings.filter((f) => f.kind === "work_item_unbacked_claim")).toEqual([]);
  });

  it("scopes all findings to exactly the --project slug", async () => {
    const v = makeVault();
    // A duplicate in acme.
    writeTranscript(v, "2026-05-08-a.md", {
      source_url: "", ingested: "2026-05-08", sha256: "0".repeat(64),
      project: '"[[acme]]"', kind: "task",
    });
    writeSpec(v, "acme", "2026-05-08-a1", { source: "raw/transcripts/2026-05-08-a.md" });
    writeSpec(v, "acme", "2026-05-08-a2", { source: "raw/transcripts/2026-05-08-a.md" });
    // A dangling claim in beta (must be ignored under --project acme).
    writeSpec(v, "beta", "2026-05-08-b", { source: "raw/transcripts/2026-05-08-b-missing.md" });

    const scoped = await runClaimsAudit({ vault: v, project: "acme" });
    expect(scoped.exitCode).toBe(0);
    if (!scoped.result.ok) throw new Error("expected ok");
    expect(
      scoped.result.data.findings.every((f) =>
        "claimedBy" in f && typeof f.claimedBy === "string"
          ? f.claimedBy.startsWith("projects/acme/")
          : true,
      ),
    ).toBe(true);
    expect(scoped.result.data.summary.duplicate_claim).toBe(1);
    // The beta dangling claim is not reported.
    expect(
      scoped.result.data.findings.filter((f) => f.kind === "dangling_claim_reference"),
    ).toEqual([]);

    // Unscoped run sees both the acme duplicate and the beta dangling claim.
    const all = await runClaimsAudit({ vault: v });
    if (!all.result.ok) throw new Error("expected ok");
    expect(all.result.data.summary.duplicate_claim).toBe(1);
    expect(all.result.data.summary.dangling_claim_reference).toBe(1);
  });

  it("rejects an unknown --project slug with UNKNOWN_PROJECT", async () => {
    const v = makeVault();
    const r = await runClaimsAudit({ vault: v, project: "does-not-exist" });
    expect(r.exitCode).toBe(37);
    expect(r.result.ok).toBe(false);
  });
});
