import { describe, it, expect, vi } from "vitest";
import { printJson, printHuman } from "../../src/utils/output.js";
import { ok, err } from "@skillwiki/shared";

describe("output", () => {
  it("printJson writes JSON.stringify of result + newline", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printJson(ok({ x: 1 }));
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ ok: true, data: { x: 1 } }) + "\n");
    spy.mockRestore();
  });

  it("printHuman renders ok results with a tag", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(ok({ msg: "hello" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("OK");
    expect(arg).toContain("hello");
    spy.mockRestore();
  });

  it("printHuman renders err results with the error code", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(err("HOST_BLOCKED", { host: "10.0.0.1" }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("HOST_BLOCKED");
    spy.mockRestore();
  });
});
