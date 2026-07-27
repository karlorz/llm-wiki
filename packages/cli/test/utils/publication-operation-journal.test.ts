import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  advancePublicationJournal,
  buildIdentitySummary,
  completePublicationJournal,
  createPublicationJournal,
  deletePublicationJournal,
  readPublicationJournal,
  resolveJournalPaths,
  vaultIdentity,
} from "../../src/utils/publication-operation-journal.js";
import { sha256Hex } from "../../src/utils/publication-approval.js";

const OP_ID = "a".repeat(64);

function identity(overrides: Partial<ReturnType<typeof buildIdentitySummary>> = {}) {
  return buildIdentitySummary({
    publisher: "project-page",
    draft_sha256: "b".repeat(64),
    target: "projects/llm-wiki/architecture/example.md",
    project: "llm-wiki",
    log_note: "note",
    prior_target_sha256: "absent",
    ...overrides,
  });
}

describe("publication-operation-journal", () => {
  it("uses privacy-preserving vault identity and private modes", () => {
    const home = mkdtempSync(join(tmpdir(), "pub-journal-home-"));
    const vault = mkdtempSync(join(tmpdir(), "pub-journal-vault-"));
    const id = vaultIdentity(vault);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // Identity is a truncated sha256 of the vault realpath (privacy-preserving).
    expect(id.length).toBe(16);

    const created = createPublicationJournal({
      vaultPath: vault,
      operationId: OP_ID,
      identity: identity(),
      home,
    });
    expect(created.ok).toBe(true);
    const paths = resolveJournalPaths(vault, OP_ID, home);
    expect(existsSync(paths.journalPath)).toBe(true);
    // POSIX permission bits are best-effort; Windows ignores chmod modes.
    if (process.platform !== "win32") {
      expect(statSync(paths.vaultDir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.journalPath).mode & 0o777).toBe(0o600);
    }

    const text = readFileSync(paths.journalPath, "utf8");
    const parsed = JSON.parse(text);
    expect(text).not.toContain("swpub1");
    expect(text).not.toContain("---\n");
    expect(parsed.identity.log_note).toBeUndefined();
    expect(parsed).not.toHaveProperty("log_note");
    expect(parsed).not.toHaveProperty("approval_token");
    expect(parsed).not.toHaveProperty("page_body");
    expect(parsed.identity.log_note_sha256).toBe(sha256Hex("note"));
  });

  it("enforces monotonic phases and identity match", () => {
    const home = mkdtempSync(join(tmpdir(), "pub-journal-home-"));
    const vault = mkdtempSync(join(tmpdir(), "pub-journal-vault-"));
    const id = identity();
    expect(createPublicationJournal({ vaultPath: vault, operationId: OP_ID, identity: id, home }).ok).toBe(true);

    expect(
      advancePublicationJournal({
        vaultPath: vault,
        operationId: OP_ID,
        identity: id,
        nextPhase: "page",
        home,
      }).ok,
    ).toBe(true);

    const regression = advancePublicationJournal({
      vaultPath: vault,
      operationId: OP_ID,
      identity: id,
      nextPhase: "locked",
      home,
    });
    expect(regression.ok).toBe(false);
    if (!regression.ok) expect(regression.error).toBe("SCHEME_REJECTED");

    const mismatch = advancePublicationJournal({
      vaultPath: vault,
      operationId: OP_ID,
      identity: identity({ target: "projects/llm-wiki/architecture/other.md" }),
      nextPhase: "verified",
      home,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toBe("APPROVAL_MISMATCH");
  });

  it("refuses malformed records and cleans up after complete", () => {
    const home = mkdtempSync(join(tmpdir(), "pub-journal-home-"));
    const vault = mkdtempSync(join(tmpdir(), "pub-journal-vault-"));
    const paths = resolveJournalPaths(vault, OP_ID, home);
    mkdirSync(paths.vaultDir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.journalPath, "{not-json", "utf8");
    const malformed = readPublicationJournal(vault, OP_ID, home);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toBe("SCHEME_REJECTED");

    unlinkSafe(paths.journalPath);
    const id = identity();
    expect(createPublicationJournal({ vaultPath: vault, operationId: OP_ID, identity: id, home }).ok).toBe(true);
    // fast-forward to log so complete can advance to complete
    for (const phase of ["taxonomy", "page", "verified", "project-index", "unlocked", "event", "log"] as const) {
      const advanced = advancePublicationJournal({
        vaultPath: vault,
        operationId: OP_ID,
        identity: id,
        nextPhase: phase,
        published: phase === "page" || phase === "verified" || true,
        verified: phase === "verified" || phase === "project-index" || true,
        home,
      });
      expect(advanced.ok).toBe(true);
    }
    expect(completePublicationJournal({ vaultPath: vault, operationId: OP_ID, identity: id, home }).ok).toBe(true);
    expect(existsSync(paths.journalPath)).toBe(false);
    const deleted = deletePublicationJournal(vault, OP_ID, home);
    expect(deleted.ok).toBe(true);
    if (deleted.ok) expect(deleted.data).toEqual({ deleted: false });
  });

  it("reports RECOVERY_EVIDENCE_MISSING when journal absent on advance", () => {
    const home = mkdtempSync(join(tmpdir(), "pub-journal-home-"));
    const vault = mkdtempSync(join(tmpdir(), "pub-journal-vault-"));
    const missing = advancePublicationJournal({
      vaultPath: vault,
      operationId: OP_ID,
      identity: identity(),
      nextPhase: "taxonomy",
      home,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("RECOVERY_EVIDENCE_MISSING");
  });
});

function unlinkSafe(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}
