import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSourceDisposition } from "../../src/commands/source-disposition.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("sources disposition command", () => {
  it("requires preview approval and is retry-idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "sw-disposition-command-"));
    dirs.push(root);
    writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
    mkdirSync(join(root, "raw", "articles"), { recursive: true });
    const rawPath = "raw/articles/source.md";
    const bytes = "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nBody\n";
    writeFileSync(join(root, rawPath), bytes);
    const preview = await runSourceDisposition({ vault: root, rawPath, status: "out-of-scope", reason: "Different vault", write: false });
    expect(preview.exitCode).toBe(0);
    if (!preview.result.ok) throw new Error("preview failed");
    const token = (preview.result.data as { approval_token: string }).approval_token;
    const applied = await runSourceDisposition({ vault: root, rawPath, status: "out-of-scope", reason: "Different vault", write: true, approve: token });
    expect(applied.exitCode).toBe(0);
    const retried = await runSourceDisposition({ vault: root, rawPath, status: "out-of-scope", reason: "Different vault", write: true, approve: token });
    expect(retried.exitCode).toBe(0);
    expect(readFileSync(join(root, rawPath), "utf8")).toBe(bytes);
  });
});
