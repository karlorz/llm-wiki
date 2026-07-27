import { describe, expect, it } from "vitest";
import {
  APPROVAL_CONTRACT,
  APPROVAL_TOKEN_VERSION,
  buildApprovalPayload,
  canonicalApprovalJson,
  decodeApprovalToken,
  encodeApprovalToken,
  normalizeLogNote,
  operationIdFromApproval,
  redactApprovalTokens,
  sha256Hex,
  verifyApprovalToken,
  type ApprovalPayload,
} from "../../src/utils/publication-approval.js";

const DRAFT = "---\ntitle: Example\n---\n\n# Example\n";
const DRAFT_HASH = sha256Hex(DRAFT);

function projectPayload(overrides: Partial<ApprovalPayload> = {}): ApprovalPayload {
  return {
    contract: APPROVAL_CONTRACT,
    publisher: "project-page",
    draft_sha256: DRAFT_HASH,
    target: "projects/llm-wiki/architecture/example.md",
    project: "llm-wiki",
    log_note: "architecture canary",
    prior_target_sha256: "absent",
    ...overrides,
  };
}

function pagePayload(overrides: Partial<ApprovalPayload> = {}): ApprovalPayload {
  return {
    contract: APPROVAL_CONTRACT,
    publisher: "page",
    draft_sha256: DRAFT_HASH,
    target: "concepts/example.md",
    log_note: "typed page canary",
    prior_target_sha256: "absent",
    ...overrides,
  };
}

describe("publication-approval", () => {
  it("uses canonical field ordering and deterministic encoding", () => {
    const payload = projectPayload();
    const json = canonicalApprovalJson(payload);
    expect(json).toBe(
      JSON.stringify({
        contract: APPROVAL_CONTRACT,
        publisher: "project-page",
        draft_sha256: DRAFT_HASH,
        target: "projects/llm-wiki/architecture/example.md",
        project: "llm-wiki",
        log_note: "architecture canary",
        prior_target_sha256: "absent",
      }),
    );
    const a = encodeApprovalToken(payload);
    const b = encodeApprovalToken(payload);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data).toBe(b.data);
  });

  it("encodes version prefix, base64url payload, and sha256 of middle segment", () => {
    const encoded = encodeApprovalToken(projectPayload());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const [version, middle, checksum] = encoded.data.split(".");
    expect(version).toBe(APPROVAL_TOKEN_VERSION);
    expect(middle).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(checksum).toBe(sha256Hex(middle!));
    expect(encoded.data.includes(DRAFT)).toBe(false);
    expect(encoded.data.includes("---")).toBe(false);
  });

  it("round-trips decode and rejects truncated/corrupted tokens", () => {
    const encoded = encodeApprovalToken(pagePayload());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeApprovalToken(encoded.data);
    expect(decoded).toMatchObject({ ok: true, data: pagePayload() });

    expect(decodeApprovalToken(encoded.data.slice(0, 20)).ok).toBe(false);
    expect(decodeApprovalToken(`${encoded.data}x`).ok).toBe(false);
    const parts = encoded.data.split(".");
    parts[2] = "0".repeat(64);
    expect(decodeApprovalToken(parts.join(".")).ok).toBe(false);
  });

  it("rejects unknown contract version and publisher kind", () => {
    const badContract = {
      ...projectPayload(),
      contract: "skillwiki-publication-approval-v0",
    } as unknown as ApprovalPayload;
    // bypass encode validation by handcrafting
    const middle = Buffer.from(
      JSON.stringify({
        contract: "skillwiki-publication-approval-v0",
        publisher: "project-page",
        draft_sha256: DRAFT_HASH,
        target: "projects/llm-wiki/architecture/example.md",
        project: "llm-wiki",
        log_note: "x",
        prior_target_sha256: "absent",
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const token = `swpub1.${middle}.${sha256Hex(middle)}`;
    const unknownContract = decodeApprovalToken(token);
    expect(unknownContract.ok).toBe(false);
    if (!unknownContract.ok) expect(unknownContract.error).toBe("APPROVAL_INVALID");

    const badPublisherMiddle = Buffer.from(
      JSON.stringify({
        contract: APPROVAL_CONTRACT,
        publisher: "wiki-git",
        draft_sha256: DRAFT_HASH,
        target: "concepts/x.md",
        log_note: "x",
        prior_target_sha256: "absent",
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const unknownPublisher = decodeApprovalToken(
      `swpub1.${badPublisherMiddle}.${sha256Hex(badPublisherMiddle)}`,
    );
    expect(unknownPublisher.ok).toBe(false);
    if (!unknownPublisher.ok) expect(unknownPublisher.error).toBe("APPROVAL_INVALID");
    void badContract;
  });

  it("refuses cross-command token replay", () => {
    const projectToken = encodeApprovalToken(projectPayload());
    const pageToken = encodeApprovalToken(pagePayload());
    expect(projectToken.ok && pageToken.ok).toBe(true);
    if (!projectToken.ok || !pageToken.ok) return;

    const crossPage = verifyApprovalToken(projectToken.data, {
      publisher: "page",
      draft_sha256: DRAFT_HASH,
      target: "concepts/example.md",
      prior_target_sha256: "absent",
      log_note: "typed page canary",
    });
    expect(crossPage.ok).toBe(false);
    if (!crossPage.ok) expect(crossPage.error).toBe("APPROVAL_MISMATCH");

    const crossProject = verifyApprovalToken(pageToken.data, {
      publisher: "project-page",
      draft_sha256: DRAFT_HASH,
      target: "projects/llm-wiki/architecture/example.md",
      project: "llm-wiki",
      prior_target_sha256: "absent",
      log_note: "architecture canary",
    });
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) expect(crossProject.error).toBe("APPROVAL_MISMATCH");
  });

  it("normalizes Unicode log notes with NFC", () => {
    // U+0065 + U+0301 (e + combining acute) vs U+00E9 (precomposed é)
    const nfd = "cafe\u0301 note";
    const nfc = "caf\u00e9 note";
    expect(normalizeLogNote(nfd)).toBe(normalizeLogNote(nfc));
    const built = buildApprovalPayload({
      publisher: "page",
      draft_sha256: DRAFT_HASH,
      target: "concepts/example.md",
      log_note: nfd,
      prior_target_sha256: "absent",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const token = encodeApprovalToken(built.data);
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    expect(
      verifyApprovalToken(token.data, {
        publisher: "page",
        draft_sha256: DRAFT_HASH,
        target: "concepts/example.md",
        log_note: nfc,
        prior_target_sha256: "absent",
      }).ok,
    ).toBe(true);
  });

  it("detects draft, target, project, log note, and prior hash mismatches", () => {
    const token = encodeApprovalToken(projectPayload({ prior_target_sha256: "a".repeat(64) }));
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const base = {
      publisher: "project-page" as const,
      draft_sha256: DRAFT_HASH,
      target: "projects/llm-wiki/architecture/example.md",
      project: "llm-wiki",
      log_note: "architecture canary",
      prior_target_sha256: "a".repeat(64),
    };
    expect(verifyApprovalToken(token.data, base).ok).toBe(true);
    for (const expected of [
      { ...base, draft_sha256: "b".repeat(64) },
      { ...base, target: "projects/llm-wiki/architecture/other.md" },
      { ...base, project: "other" },
      { ...base, log_note: "different" },
      { ...base, prior_target_sha256: "absent" },
    ]) {
      const mismatch = verifyApprovalToken(token.data, expected);
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.error).toBe("APPROVAL_MISMATCH");
    }
  });

  it("handles absent prior target and omits project for page publisher", () => {
    const page = encodeApprovalToken(pagePayload());
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const decoded = decodeApprovalToken(page.data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.data.project).toBeUndefined();
    expect(decoded.data.prior_target_sha256).toBe("absent");
    expect(canonicalApprovalJson(decoded.data)).not.toContain('"project"');
  });

  it("derives stable operation ids from approved payload identity", () => {
    const a = operationIdFromApproval(projectPayload());
    const b = operationIdFromApproval(projectPayload());
    const c = operationIdFromApproval(projectPayload({ log_note: "other" }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(operationIdFromApproval(pagePayload()));
  });

  it("redacts tokens from free-form text", () => {
    const token = encodeApprovalToken(pagePayload());
    expect(token.ok).toBe(true);
    if (!token.ok) return;
    const redacted = redactApprovalTokens(`approve with ${token.data} please`);
    expect(redacted).toContain("swpub1.[REDACTED]");
    expect(redacted).not.toContain(token.data);
  });
});
