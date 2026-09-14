import { describe, expect, it } from "vitest";
import { toolResult } from "../src/server.js";

describe("toolResult", () => {
  it("data becomes structuredContent plus JSON text; isError true adds isError", () => {
    const data = { ok: true, path: "concepts/alpha.md" };
    const ok = toolResult(data);
    expect(ok.structuredContent).toEqual(data);
    expect(ok.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
    expect(ok).not.toHaveProperty("isError");

    const errData = { ok: false, error: "USAGE" };
    const err = toolResult(errData, true);
    expect(err.structuredContent).toEqual(errData);
    expect(err.content).toEqual([{ type: "text", text: JSON.stringify(errData) }]);
    expect(err.isError).toBe(true);
  });
});
