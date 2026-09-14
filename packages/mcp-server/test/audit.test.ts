import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { appendAudit } from "../src/audit.js";

const entry = {
  host_id: "macos-dev",
  tool: "wiki_status",
  ok: true,
  ms: 12,
};

describe("appendAudit", () => {
  it("undefined filePath is a no-op; a path writes one JSON line with ts", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillwiki-mcp-audit-"));
    const sentinel = join(root, "untouched.jsonl");
    await writeFile(sentinel, "keep\n", "utf8");

    appendAudit(undefined, entry);
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");

    const filePath = join(root, "audit.jsonl");
    appendAudit(filePath, entry);
    const text = await readFile(filePath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as { ts: string; host_id: string; tool: string; ok: boolean; ms: number };
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.host_id).toBe("macos-dev");
    expect(parsed.tool).toBe("wiki_status");
    expect(parsed.ok).toBe(true);
    expect(parsed.ms).toBe(12);
  });
});
