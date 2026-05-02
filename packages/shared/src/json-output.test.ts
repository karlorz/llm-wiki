import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "./json-output.js";

describe("json-output", () => {
  it("ok() produces { ok: true, data }", () => {
    const r = ok({ x: 1 });
    expect(r).toEqual({ ok: true, data: { x: 1 } });
    expect(isOk(r)).toBe(true);
  });

  it("err() produces { ok: false, error, detail? }", () => {
    const r = err("HOST_BLOCKED", { url: "x" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HOST_BLOCKED");
    expect(isErr(r)).toBe(true);
  });
});
