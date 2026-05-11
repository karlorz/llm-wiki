import { describe, it, expect, vi, afterEach } from "vitest";
import { npmViewVersion, npmInstallGlobal } from "../../src/utils/npm.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

describe("npm utilities", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("npmViewVersion", () => {
    it("queries npm registry for the specified tag", () => {
      mockExecSync.mockReturnValue("1.2.3-beta.4\n");
      const result = npmViewVersion("beta");
      expect(result).toBe("1.2.3-beta.4");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("skillwiki@beta"),
        expect.objectContaining({ encoding: "utf8" }),
      );
    });

    it("defaults to latest tag when no tag provided", () => {
      mockExecSync.mockReturnValue("0.2.0\n");
      npmViewVersion();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("skillwiki@latest"),
        expect.anything(),
      );
    });

    it("propagates execSync errors (registry unreachable)", () => {
      mockExecSync.mockImplementation(() => { throw new Error("ETIMEDOUT"); });
      expect(() => npmViewVersion()).toThrow("ETIMEDOUT");
    });
  });

  describe("npmInstallGlobal", () => {
    it("installs globally with the specified tag", () => {
      mockExecSync.mockReturnValue(undefined);
      npmInstallGlobal("beta", "ignore");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g skillwiki@beta"),
        expect.objectContaining({ stdio: "ignore" }),
      );
    });

    it("defaults to latest tag and ignore stdio", () => {
      mockExecSync.mockReturnValue(undefined);
      npmInstallGlobal();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("skillwiki@latest"),
        expect.objectContaining({ stdio: "ignore" }),
      );
    });

    it("supports pipe stdio mode", () => {
      mockExecSync.mockReturnValue(undefined);
      npmInstallGlobal("latest", "pipe");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("skillwiki@latest"),
        expect.objectContaining({ stdio: "pipe" }),
      );
    });

    it("propagates execSync errors (install failure)", () => {
      mockExecSync.mockImplementation(() => { throw new Error("EACCES"); });
      expect(() => npmInstallGlobal()).toThrow("EACCES");
    });
  });
});
