import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SkillwikiLogEventV1 } from "../../src/utils/log-events.js";
import {
  COMPILE_CLAIM_TTL_MS,
  applySourceCompileClaim,
  applySourceCompilePublished,
  applySourceCompileRelease,
  applySourceReview,
  effectiveCompileState,
  planSourceCompileClaim,
  planSourceCompilePublished,
  planSourceCompileRelease,
  planSourceReview,
  projectSourceCompileEvents,
} from "../../src/utils/source-compile.js";
import { completeSha256 } from "../../src/utils/source-dispositions.js";
import { applySourceDisposition, planSourceDisposition } from "../../src/utils/source-dispositions.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(body = "Body\n"): { root: string; rawPath: string; text: string } {
  const root = mkdtempSync(join(tmpdir(), "sw-compile-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  const rawPath = "raw/articles/source.md";
  const text = `---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\n${body}`;
  writeFileSync(join(root, rawPath), text);
  return { root, rawPath, text };
}

function event(partial: Partial<SkillwikiLogEventV1> & Pick<SkillwikiLogEventV1, "kind" | "target" | "metadata">): SkillwikiLogEventV1 {
  return {
    schema: "skillwiki-log-event/v1",
    operation_id: (partial.operation_id ?? "a".repeat(64)),
    occurred_at: partial.occurred_at ?? "2026-08-17T00:00:00.000Z",
    host_id: partial.host_id ?? "test-host",
    actor: partial.actor ?? "tester",
    note: partial.note ?? "test",
    kind: partial.kind,
    target: partial.target,
    metadata: partial.metadata,
  };
}

describe("source compile projection", () => {
  it("treats an unexpired claim as compiling", () => {
    const projected = projectSourceCompileEvents([
      event({
        kind: "source-compile-claimed",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          expires_at: "2026-08-17T02:00:00.000Z",
          session_kind: "interactive",
          reason: "compile",
          turn_id: "c".repeat(64),
        },
      }),
    ]);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const state = effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "b".repeat(64),
      now: "2026-08-17T01:00:00.000Z",
    });
    expect(state).toMatchObject({ status: "compiling", identityMismatch: false });
  });

  it("expires a claim after the 2h TTL", () => {
    const claimedAt = "2026-08-17T00:00:00.000Z";
    const expires = new Date(Date.parse(claimedAt) + COMPILE_CLAIM_TTL_MS).toISOString();
    const projected = projectSourceCompileEvents([
      event({
        kind: "source-compile-claimed",
        occurred_at: claimedAt,
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          expires_at: expires,
          session_kind: "interactive",
          reason: "compile",
          turn_id: "c".repeat(64),
        },
      }),
    ]);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    const state = effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "b".repeat(64),
      now: "2026-08-17T02:00:00.001Z",
    });
    expect(state.status).toBe("none");
  });

  it("clears compiling after release", () => {
    const projected = projectSourceCompileEvents([
      event({
        kind: "source-compile-claimed",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          expires_at: "2026-08-17T02:00:00.000Z",
          session_kind: "interactive",
          reason: "compile",
          turn_id: "c".repeat(64),
        },
      }),
      event({
        operation_id: "d".repeat(64),
        occurred_at: "2026-08-17T00:10:00.000Z",
        kind: "source-compile-released",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          reason: "stop",
        },
      }),
    ]);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "b".repeat(64),
      now: "2026-08-17T00:11:00.000Z",
    }).status).toBe("none");
  });

  it("projects published plus open review as review-open", () => {
    const projected = projectSourceCompileEvents([
      event({
        kind: "source-compile-published",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          typed_paths: ["concepts/example.md"],
          turn_id: "c".repeat(64),
        },
      }),
      event({
        operation_id: "e".repeat(64),
        occurred_at: "2026-08-17T00:01:00.000Z",
        kind: "source-review",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          turn_id: "c".repeat(64),
          status: "open",
          typed_paths: ["concepts/example.md"],
          reason: "opened",
        },
      }),
    ]);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "b".repeat(64),
      now: "2026-08-17T00:02:00.000Z",
    }).status).toBe("review-open");
  });

  it("closes review on accepted and flags sha mismatch", () => {
    const projected = projectSourceCompileEvents([
      event({
        kind: "source-review",
        target: "raw/articles/source.md",
        metadata: {
          raw_path: "raw/articles/source.md",
          complete_sha256: "b".repeat(64),
          turn_id: "c".repeat(64),
          status: "accepted",
          reason: "ok",
        },
      }),
    ]);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "b".repeat(64),
      now: "2026-08-17T00:02:00.000Z",
    }).status).toBe("review-closed");
    expect(effectiveCompileState({
      events: projected.data,
      rawPath: "raw/articles/source.md",
      completeSha256: "f".repeat(64),
      now: "2026-08-17T00:02:00.000Z",
    }).identityMismatch).toBe(true);
  });
});

describe("source compile plan/apply", () => {
  it("claims a pending article and expires after 2h so another actor can claim", async () => {
    const { root, rawPath, text } = vault();
    const now = "2026-08-17T00:00:00.000Z";
    const plan = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start compile",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.data.expires_at).toBe(new Date(Date.parse(now) + COMPILE_CLAIM_TTL_MS).toISOString());
    const applied = await applySourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start compile",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: plan.data.approval_token,
    });
    expect(applied.ok).toBe(true);

    const blocked = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Steal",
      sessionKind: "interactive",
      actor: "bob",
      hostId: "host-b",
      now: "2026-08-17T01:00:00.000Z",
    });
    expect(blocked.ok).toBe(false);

    const afterTtl = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Retry",
      sessionKind: "interactive",
      actor: "bob",
      hostId: "host-b",
      now: "2026-08-17T02:00:00.001Z",
    });
    expect(afterTtl.ok).toBe(true);
    expect(completeSha256(text)).toHaveLength(64);
  });

  it("lets the same actor renew and rejects non-interactive sessions", async () => {
    const { root, rawPath } = vault();
    const first = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:00:00.000Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await applySourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: first.data.approval_token,
    });
    const renew = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Renew",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:30:00.000Z",
    });
    expect(renew.ok).toBe(true);
    const headless = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Headless",
      sessionKind: "headless",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:31:00.000Z",
    });
    expect(headless.ok).toBe(false);
  });

  it("releases a claim so another actor can claim", async () => {
    const { root, rawPath } = vault();
    const claim = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:00:00.000Z",
    });
    if (!claim.ok) throw new Error("claim plan failed");
    await applySourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: claim.data.approval_token,
    });
    const release = await planSourceCompileRelease({
      vault: root,
      rawPath,
      reason: "Stop",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:05:00.000Z",
    });
    expect(release.ok).toBe(true);
    if (!release.ok) return;
    await applySourceCompileRelease({
      vault: root,
      rawPath,
      reason: "Stop",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: release.data.approval_token,
    });
    const next = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Take over",
      sessionKind: "interactive",
      actor: "bob",
      hostId: "host-b",
      now: "2026-08-17T00:06:00.000Z",
    });
    expect(next.ok).toBe(true);
  });

  it("rejects transcripts and non-pending dispositions", async () => {
    const { root } = vault();
    mkdirSync(join(root, "raw", "transcripts"), { recursive: true });
    writeFileSync(join(root, "raw", "transcripts", "note.md"), "---\ntitle: Note\nsource_url: null\ningested: 2026-08-02\n---\nHi\n");
    const transcript = await planSourceCompileClaim({
      vault: root,
      rawPath: "raw/transcripts/note.md",
      reason: "nope",
      sessionKind: "interactive",
    });
    expect(transcript.ok).toBe(false);

    const disp = await planSourceDisposition({
      vault: root,
      rawPath: "raw/articles/source.md",
      status: "out-of-scope",
      reason: "Skip",
      now: "2026-08-17T00:00:00.000Z",
    });
    if (!disp.ok) throw new Error("disposition plan failed");
    await applySourceDisposition({
      vault: root,
      rawPath: "raw/articles/source.md",
      status: "out-of-scope",
      reason: "Skip",
      approve: disp.data.approval_token,
    });
    const blocked = await planSourceCompileClaim({
      vault: root,
      rawPath: "raw/articles/source.md",
      reason: "after disposition",
      sessionKind: "interactive",
    });
    expect(blocked.ok).toBe(false);
  });

  it("records published pages and an open review without writing a disposition", async () => {
    const { root, rawPath } = vault();
    const claim = await planSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:00:00.000Z",
    });
    if (!claim.ok) throw new Error("claim failed");
    await applySourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: claim.data.approval_token,
    });
    mkdirSync(join(root, "concepts"), { recursive: true });
    writeFileSync(join(root, "concepts", "example.md"), "---\ntitle: Example\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/source.md]\n---\nBody\n");
    const published = await planSourceCompilePublished({
      vault: root,
      rawPath,
      pages: ["concepts/example.md"],
      reason: "Published",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:10:00.000Z",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const applied = await applySourceCompilePublished({
      vault: root,
      rawPath,
      pages: ["concepts/example.md"],
      reason: "Published",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: published.data.approval_token,
    });
    expect(applied.ok).toBe(true);
    const review = await planSourceReview({
      vault: root,
      rawPath,
      status: "accepted",
      reason: "Looks good",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      now: "2026-08-17T00:20:00.000Z",
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const reviewed = await applySourceReview({
      vault: root,
      rawPath,
      status: "accepted",
      reason: "Looks good",
      sessionKind: "interactive",
      actor: "alice",
      hostId: "host-a",
      approve: review.data.approval_token,
    });
    expect(reviewed.ok).toBe(true);
  });

  it("rejects empty or invalid typed pages", async () => {
    const { root, rawPath } = vault();
    const empty = await planSourceCompilePublished({
      vault: root,
      rawPath,
      pages: [],
      reason: "none",
      sessionKind: "interactive",
    });
    expect(empty.ok).toBe(false);
    const bad = await planSourceCompilePublished({
      vault: root,
      rawPath,
      pages: ["raw/articles/source.md"],
      reason: "not typed",
      sessionKind: "interactive",
    });
    expect(bad.ok).toBe(false);
  });
});
