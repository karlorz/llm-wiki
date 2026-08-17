import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSourceCompileClaim,
  runSourceCompilePublished,
  runSourceCompileRelease,
  runSourceCompileStatus,
  runSourceReview,
  runSourceReviews,
} from "../../src/commands/source-compile.js";
import { runSourcesPending } from "../../src/commands/sources.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(): { root: string; rawPath: string } {
  const root = mkdtempSync(join(tmpdir(), "sw-compile-cmd-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  const rawPath = "raw/articles/source.md";
  writeFileSync(join(root, rawPath), "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nBody\n");
  return { root, rawPath };
}

describe("sources compile / review commands", () => {
  it("requires preview approval and records a claim", async () => {
    const { root, rawPath } = vault();
    const preview = await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start compile",
      sessionKind: "interactive",
      write: false,
    });
    expect(preview.exitCode).toBe(0);
    if (!preview.result.ok) throw new Error("preview failed");
    const token = (preview.result.data as { approval_token: string }).approval_token;
    const missing = await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start compile",
      sessionKind: "interactive",
      write: true,
    });
    expect(missing.exitCode).not.toBe(0);
    const applied = await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start compile",
      sessionKind: "interactive",
      write: true,
      approve: token,
    });
    expect(applied.exitCode).toBe(0);
  });

  it("rejects non-interactive mutate and allows list", async () => {
    const { root, rawPath } = vault();
    const blocked = await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "nope",
      sessionKind: "goal",
    });
    expect(blocked.exitCode).not.toBe(0);
    const listed = await runSourceCompileStatus({ vault: root });
    expect(listed.exitCode).toBe(0);
  });

  it("releases, publishes, and lists open reviews", async () => {
    const { root, rawPath } = vault();
    const claim = await runSourceCompileClaim({ vault: root, rawPath, reason: "Start", sessionKind: "interactive" });
    if (!claim.result.ok) throw new Error("claim preview failed");
    await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Start",
      sessionKind: "interactive",
      write: true,
      approve: (claim.result.data as { approval_token: string }).approval_token,
    });
    const release = await runSourceCompileRelease({ vault: root, rawPath, reason: "Stop", sessionKind: "interactive" });
    if (!release.result.ok) throw new Error("release preview failed");
    await runSourceCompileRelease({
      vault: root,
      rawPath,
      reason: "Stop",
      sessionKind: "interactive",
      write: true,
      approve: (release.result.data as { approval_token: string }).approval_token,
    });
    const claim2 = await runSourceCompileClaim({ vault: root, rawPath, reason: "Again", sessionKind: "interactive" });
    if (!claim2.result.ok) throw new Error("second claim failed");
    await runSourceCompileClaim({
      vault: root,
      rawPath,
      reason: "Again",
      sessionKind: "interactive",
      write: true,
      approve: (claim2.result.data as { approval_token: string }).approval_token,
    });
    mkdirSync(join(root, "concepts"), { recursive: true });
    writeFileSync(join(root, "concepts", "example.md"), "---\ntitle: Example\ncreated: 2026-08-17\nupdated: 2026-08-17\ntype: concept\ntags: [tooling]\nsources: [raw/articles/source.md]\n---\nBody\n");
    const published = await runSourceCompilePublished({
      vault: root,
      rawPath,
      pages: ["concepts/example.md"],
      reason: "Filed",
      sessionKind: "interactive",
    });
    expect(published.exitCode).toBe(0);
    if (!published.result.ok) throw new Error("publish preview failed");
    const wrote = await runSourceCompilePublished({
      vault: root,
      rawPath,
      pages: ["concepts/example.md"],
      reason: "Filed",
      sessionKind: "interactive",
      write: true,
      approve: (published.result.data as { approval_token: string }).approval_token,
    });
    expect(wrote.exitCode).toBe(0);
    const reviews = await runSourceReviews({ vault: root });
    expect(reviews.result.ok && (reviews.result.data as { items: unknown[] }).items).toHaveLength(1);
    const accept = await runSourceReview({
      vault: root,
      rawPath,
      status: "accepted",
      reason: "ok",
      sessionKind: "interactive",
    });
    if (!accept.result.ok) throw new Error("review preview failed");
    await runSourceReview({
      vault: root,
      rawPath,
      status: "accepted",
      reason: "ok",
      sessionKind: "interactive",
      write: true,
      approve: (accept.result.data as { approval_token: string }).approval_token,
    });
    const pending = await runSourcesPending({ vault: root, today: "2026-08-17" });
    expect(pending.result.ok && pending.result.data.items).toEqual([]);
  });
});
