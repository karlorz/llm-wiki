import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSelfUpdate } from "../../src/commands/self-update.js";

// Mock child_process.execSync to avoid real npm calls
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const currentVersion = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8")
).version;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "self-update-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

/** Create a fake local source checkout with a given version. */
function createLocalSource(parentDir: string, version: string): string {
  const root = join(parentDir, "llm-wiki");
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  writeFileSync(
    join(root, "packages", "cli", "package.json"),
    JSON.stringify({ name: "skillwiki", version })
  );
  return root;
}

describe("runSelfUpdate", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  // --- --check mode ---

  describe("--check", () => {
    it("reports update available from local source when version differs", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");

      const r = await runSelfUpdate({ home: h, check: true, sourceRoot });
      expect(r.exitCode).toBe(0);
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("local");
        expect(r.result.data.currentVersion).toBe(currentVersion);
        expect(r.result.data.availableVersion).toBe("0.3.0-fake");
        expect(r.result.data.updateAvailable).toBe(true);
        expect(r.result.data.humanHint).toContain("0.3.0-fake");
      }
    });

    it("reports no update from local source when versions match", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, currentVersion);

      const r = await runSelfUpdate({ home: h, check: true, sourceRoot });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("local");
        expect(r.result.data.updateAvailable).toBe(false);
        expect(r.result.data.humanHint).toContain("Already up to date");
      }
    });

    it("falls back to npm when no local source exists", async () => {
      const h = home();
      mockExec.mockReturnValueOnce("0.2.0-beta.99\n");

      const r = await runSelfUpdate({ home: h, check: true, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("npm");
        expect(r.result.data.availableVersion).toBe("0.2.0-beta.99");
        expect(r.result.data.updateAvailable).toBe(true);
      }
    });

    it("reports no update from npm when versions match", async () => {
      const h = home();
      mockExec.mockReturnValueOnce(`${currentVersion}\n`);

      const r = await runSelfUpdate({ home: h, check: true, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("npm");
        expect(r.result.data.updateAvailable).toBe(false);
      }
    });

    it("returns error when npm view fails", async () => {
      const h = home();
      mockExec.mockImplementationOnce(() => { throw new Error("network error"); });

      const r = await runSelfUpdate({ home: h, check: true, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(1);
      expect(r.result.ok).toBe(false);
    });
  });

  // --- local source update ---

  describe("local source update", () => {
    it("builds and links from local source", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockReturnValueOnce(undefined); // npm run build
      mockExec.mockReturnValueOnce(undefined); // npm link

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("local");
        expect(r.result.data.newVersion).toBe("0.3.0-fake");
        expect(r.result.data.humanHint).toContain("0.3.0-fake");
        expect(r.result.data.humanHint).toContain("local source");
      }
    });

    it("calls npm run build with correct cwd and workspace", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockReturnValueOnce(undefined); // build
      mockExec.mockReturnValueOnce(undefined); // link

      await runSelfUpdate({ home: h, check: false, sourceRoot });
      expect(mockExec).toHaveBeenCalledWith(
        "npm run build -w packages/cli",
        expect.objectContaining({ cwd: sourceRoot }),
      );
    });

    it("calls npm link with correct cwd after build", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockReturnValueOnce(undefined); // build
      mockExec.mockReturnValueOnce(undefined); // link

      await runSelfUpdate({ home: h, check: false, sourceRoot });
      expect(mockExec).toHaveBeenCalledWith(
        "npm link ./packages/cli",
        expect.objectContaining({ cwd: sourceRoot }),
      );
    });

    it("returns error when build fails", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockImplementationOnce(() => { throw new Error("build error"); });

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot });
      expect(r.exitCode).toBe(1);
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) {
        expect(r.result.error).toBe("BUILD_FAILED");
      }
    });

    it("returns error when link fails", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockReturnValueOnce(undefined); // build succeeds
      mockExec.mockImplementationOnce(() => { throw new Error("link error"); });

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot });
      expect(r.exitCode).toBe(1);
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) {
        expect(r.result.error).toBe("LINK_FAILED");
      }
    });

    it("does not call npm commands when local source exists", async () => {
      const h = home();
      const sourceRoot = createLocalSource(h, "0.3.0-fake");
      mockExec.mockReturnValueOnce(undefined); // npm run build
      mockExec.mockReturnValueOnce(undefined); // npm link

      await runSelfUpdate({ home: h, check: false, sourceRoot });

      // Only build and link should be called, no npm view or npm install
      expect(mockExec).toHaveBeenCalledTimes(2);
      expect(mockExec).toHaveBeenCalledWith(
        "npm run build -w packages/cli",
        expect.any(Object),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "npm link ./packages/cli",
        expect.any(Object),
      );
    });

    it("returns 'unknown' version when reading local source version fails after build+link", async () => {
      const h = home();
      const root = join(h, "llm-wiki");
      mkdirSync(join(root, "packages", "cli"), { recursive: true });
      writeFileSync(join(root, "packages", "cli", "package.json"), "NOT VALID JSON");
      mockExec.mockReturnValueOnce(undefined); // build
      mockExec.mockReturnValueOnce(undefined); // link

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot: root });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.newVersion).toBe("unknown");
        expect(r.result.data.humanHint).toContain("unknown");
      }
    });
  });

  // --- npm fallback ---

  describe("npm fallback", () => {
    it("installs from npm@beta when no local source", async () => {
      const h = home();
      mockExec.mockReturnValueOnce("0.2.0-beta.99\n"); // npm view
      mockExec.mockReturnValueOnce(undefined); // npm install

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("npm");
        expect(r.result.data.newVersion).toBe("0.2.0-beta.99");
        expect(r.result.data.humanHint).toContain("npm@beta");
      }
    });

    it("uses skillwiki@beta in npm view and install commands", async () => {
      const h = home();
      mockExec.mockReturnValueOnce("0.2.0-beta.99\n");
      mockExec.mockReturnValueOnce(undefined);

      await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });
      expect(mockExec).toHaveBeenCalledWith(
        "npm view skillwiki@beta version",
        expect.any(Object),
      );
      expect(mockExec).toHaveBeenCalledWith(
        "npm install -g skillwiki@beta",
        expect.any(Object),
      );
    });

    it("reports already latest when npm version matches", async () => {
      const h = home();
      mockExec.mockReturnValueOnce(`${currentVersion}\n`);

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(0);
      if (r.result.ok) {
        expect(r.result.data.source).toBe("npm");
        expect(r.result.data.updateAvailable).toBe(false);
        expect(r.result.data.newVersion).toBeUndefined();
        expect(r.result.data.humanHint).toContain("Already on latest beta");
      }
    });

    it("returns error when npm view fails", async () => {
      const h = home();
      mockExec.mockImplementationOnce(() => { throw new Error("network error"); });

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(1);
      expect(r.result.ok).toBe(false);
    });

    it("returns error when npm install fails", async () => {
      const h = home();
      mockExec.mockReturnValueOnce("0.2.0-beta.99\n"); // npm view succeeds
      mockExec.mockImplementationOnce(() => { throw new Error("permission denied"); }); // install fails

      const r = await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });
      expect(r.exitCode).toBe(1);
      expect(r.result.ok).toBe(false);
      if (!r.result.ok) {
        expect(r.result.error).toBe("INSTALL_FAILED");
      }
    });

    it("does not call npm install when already on latest beta", async () => {
      const h = home();
      mockExec.mockReturnValueOnce(`${currentVersion}\n`); // npm view only

      await runSelfUpdate({ home: h, check: false, sourceRoot: "/nonexistent" });

      // Only npm view should be called, no npm install
      expect(mockExec).toHaveBeenCalledTimes(1);
      expect(mockExec).toHaveBeenCalledWith(
        "npm view skillwiki@beta version",
        expect.any(Object),
      );
    });
  });
});
