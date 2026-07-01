import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runQuery } from "../../src/commands/query.js";
import { formatToolResult } from "../../src/mcp/result-format.js";

const VAULT = join(__dirname, "..", "fixtures", "sample-vault");

describe("MCP query wrapper", () => {
  it("formatToolResult preserves Result envelope from runQuery", async () => {
    const r = await runQuery({ text: "alpha", vault: VAULT });
    const out = formatToolResult(r);
    expect(out.content[0]!.type).toBe("text");
    const parsed = JSON.parse(out.content[0]!.text) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(out._meta?.exitCode).toBe(0);
  });
});