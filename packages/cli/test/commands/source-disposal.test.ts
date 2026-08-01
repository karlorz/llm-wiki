import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSourceDisposal } from "../../src/commands/source-disposal.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-disposal-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  mkdirSync(join(root, "concepts"), { recursive: true });
  writeFileSync(join(root, "raw", "articles", "source.md"), "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nBody\n");
  writeFileSync(join(root, "concepts", "source.md"), "---\ntitle: Source\ntype: concept\ncreated: 2026-08-02\nupdated: 2026-08-02\ntags: []\nsources: [raw/articles/source.md]\n---\nClaim. ^[raw/articles/source.md]\n");
  return root;
}

describe("sources dispose", () => {
  it("previews citation impact and requires attended exact-target approval", async () => {
    const root = vault();
    const preview = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "User explicitly requested permanent removal" });
    expect(preview.exitCode).toBe(0);
    if (!preview.result.ok) throw new Error("preview failed");
    const plan = preview.result.data as { approval_token: string; typed_references: string[]; complete_sha256: string };
    expect(plan.typed_references).toEqual(["concepts/source.md"]);
    expect(plan.complete_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(root, "raw", "articles", "source.md"))).toBe(true);

    const headless = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "User explicitly requested permanent removal", write: true, approve: plan.approval_token, attended: false });
    expect(headless.exitCode).not.toBe(0);
    expect(existsSync(join(root, "raw", "articles", "source.md"))).toBe(true);

    const applied = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "User explicitly requested permanent removal", write: true, approve: plan.approval_token, attended: true });
    expect(applied.exitCode).toBe(0);
    expect(existsSync(join(root, "raw", "articles", "source.md"))).toBe(false);
    expect(existsSync(join(root, "meta", "delete-intents", "raw__articles__source.md.json"))).toBe(true);
    const events = readdirSync(join(root, "meta", "log-events", new Date().toISOString().slice(0, 10)))
      .map(file => JSON.parse(readFileSync(join(root, "meta", "log-events", new Date().toISOString().slice(0, 10), file), "utf8")) as { kind: string });
    expect(events.map(event => event.kind).sort()).toEqual(["source-disposal-approved", "source-disposal-completed"]);
  });

  it("invalidates approval when raw bytes or inbound references change", async () => {
    const root = vault();
    const preview = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "Exact request" });
    if (!preview.result.ok) throw new Error("preview failed");
    const token = (preview.result.data as { approval_token: string }).approval_token;
    writeFileSync(join(root, "raw", "articles", "source.md"), readFileSync(join(root, "raw", "articles", "source.md"), "utf8") + "changed\n");
    const applied = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "Exact request", write: true, approve: token, attended: true });
    expect(applied.exitCode).not.toBe(0);
    expect(existsSync(join(root, "raw", "articles", "source.md"))).toBe(true);
  });

  it("rejects basenames, globs, and directories", async () => {
    const root = vault();
    expect((await runSourceDisposal({ vault: root, rawPath: "source.md", reason: "x" })).exitCode).not.toBe(0);
    expect((await runSourceDisposal({ vault: root, rawPath: "raw/articles/*.md", reason: "x" })).exitCode).not.toBe(0);
    expect((await runSourceDisposal({ vault: root, rawPath: "raw/articles/", reason: "x" })).exitCode).not.toBe(0);
  });

  it("rejects direct target symlinks and symlinked raw parents", async () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), "sw-disposal-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "source.md"), "outside");
    rmSync(join(root, "raw", "articles", "source.md"));
    symlinkSync(join(outside, "source.md"), join(root, "raw", "articles", "source.md"));
    const direct = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "Exact request" });
    expect(direct.result.ok).toBe(false);
    expect(readFileSync(join(outside, "source.md"), "utf8")).toBe("outside");

    rmSync(join(root, "raw", "articles"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "raw", "articles"));
    const parent = await runSourceDisposal({ vault: root, rawPath: "raw/articles/source.md", reason: "Exact request" });
    expect(parent.result.ok).toBe(false);
    expect(readFileSync(join(outside, "source.md"), "utf8")).toBe("outside");
  });
});
