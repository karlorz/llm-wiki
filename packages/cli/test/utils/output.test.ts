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

  it("printHuman uses humanHint when present on ok data", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(ok({ humanHint: "3 skills installed", count: 3 }));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("3 skills installed");
    expect(arg).not.toContain("OK");
    spy.mockRestore();
  });

  it("printHuman renders err without detail", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHuman(err("SOME_ERROR"));
    const arg = (spy.mock.calls[0][0] as string);
    expect(arg).toContain("ERR SOME_ERROR");
    spy.mockRestore();
  });

  it("printJson writes err result as JSON", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printJson(err("BOOM", { reason: "test" }));
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "BOOM", detail: { reason: "test" } }) + "\n");
    spy.mockRestore();
  });
});
