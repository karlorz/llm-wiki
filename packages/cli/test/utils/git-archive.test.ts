import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { extractGitTree } from "../../src/utils/git-archive.js";
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ rmSync: vi.fn() }));
const original = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", original); vi.resetAllMocks(); });
describe("Windows Git archive Unicode extraction", () => {
  it("passes Unicode and shell metacharacter paths as data to the Unicode-capable extractor", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const source = "C:\\fixture\\vault", destination = "C:\\fixture\\中文 '$() archive";
    extractGitTree(source, "main", destination);
    const call = vi.mocked(execFileSync).mock.calls[1];
    expect(call[0]).toBe("powershell.exe");
    expect(call[1]).not.toContain(destination);
    expect(call[2]).toMatchObject({ env: { SKILLWIKI_ARCHIVE_SOURCE: destination + ".zip", SKILLWIKI_ARCHIVE_DEST: destination } });
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith(destination + ".zip", { force: true });
  });
  it("removes the temporary archive when Windows extraction fails", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(execFileSync).mockImplementationOnce(() => Buffer.alloc(0)).mockImplementationOnce(() => { throw new Error("extraction refused"); });
    expect(() => extractGitTree("C:\\fixture", "main", "C:\\restore")).toThrow("extraction refused");
    expect(vi.mocked(rmSync)).toHaveBeenCalledWith("C:\\restore.zip", { force: true });
  });
});
