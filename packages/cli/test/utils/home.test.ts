import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveSkillwikiHome } from "../../src/utils/home.js";

vi.mock("node:os", () => ({ homedir: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("resolveSkillwikiHome", () => {
  it("preserves explicit home precedence", () => {
    expect(resolveSkillwikiHome("explicit-home", { HOME: "env-home", USERPROFILE: "profile" }))
      .toBe(resolve("explicit-home"));
    expect(homedir).not.toHaveBeenCalled();
  });

  it("prefers a nonblank HOME over USERPROFILE", () => {
    expect(resolveSkillwikiHome(undefined, { HOME: "env-home", USERPROFILE: "profile" }))
      .toBe(resolve("env-home"));
  });

  it.each([undefined, "", "   "])("ignores blank HOME %j", (home) => {
    expect(resolveSkillwikiHome("", { HOME: home, USERPROFILE: "profile" })).toBe(resolve("profile"));
  });

  it("uses OS home when environment candidates are blank", () => {
    vi.mocked(homedir).mockReturnValue("os-home");
    expect(resolveSkillwikiHome(" ", { HOME: "", USERPROFILE: " " })).toBe(resolve("os-home"));
  });

  it("preserves whitespace in a nonblank path", () => {
    expect(resolveSkillwikiHome("home with spaces ", {})).toBe(resolve("home with spaces "));
  });

  it("fails explicitly when OS home discovery fails", () => {
    vi.mocked(homedir).mockImplementation(() => { throw new Error("system failure"); });
    expect(() => resolveSkillwikiHome(undefined, {})).toThrow("Could not resolve SkillWiki home directory");
  });

  it("fails explicitly when OS home is blank", () => {
    vi.mocked(homedir).mockReturnValue("");
    expect(() => resolveSkillwikiHome(undefined, {})).toThrow("Could not resolve SkillWiki home directory");
  });

  it.skipIf(process.platform !== "win32")("resolves native Windows USERPROFILE", () => {
    expect(resolveSkillwikiHome(undefined, { HOME: "", USERPROFILE: "C:\\Users\\Fixture User" }))
      .toBe("C:\\Users\\Fixture User");
  });
});
