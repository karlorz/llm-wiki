import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runUpdate } from "../../src/commands/update.js";
import { cachePath } from "../../src/utils/auto-update.js";

// Mock child_process.execSync to avoid real npm calls
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Mock the install module so refreshInstalledSkills gets a controlled result
vi.mock("../../src/commands/install.js", () => ({
  runInstall: vi.fn(),
}));

import { execSync } from "node:child_process";
import { runInstall } from "../../src/commands/install.js";
const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;
const mockInstall = runInstall as unknown as ReturnType<typeof vi.fn>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const currentVersion = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8")
).version;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "update-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

/** Convenience: mock runInstall returning a successful install with given version_warnings. */
function mockInstallSuccess(version_warnings: string[] = [], deferred_to_plugin = false) {
  mockInstall.mockResolvedValueOnce({
    exitCode: 0,
    result: {
      ok: true as const,
      data: {
        installed: [],
        backed_up: [],
        manifest_path: "/fake/manifest",
        version_warnings,
        deferred_to_plugin,
        humanHint: "installed: 0",
      },
    },
  });
}

/** Convenience: mock runInstall returning a failure. */
function mockInstallFailure(error: string) {
  mockInstall.mockResolvedValueOnce({
    exitCode: 13,
    result: { ok: false, error, detail: {} },
  });
}

describe("runUpdate", () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockInstall.mockReset();
  });

  it("reports already latest when versions match", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`); // npm view returns current version

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wasAlreadyLatest).toBe(true);
      expect(r.result.data.newVersion).toBeNull();
      expect(r.result.data.version_warnings).toEqual([]);
      expect(r.result.data.skills_refreshed).toBe(false);
    }
  });

  it("updates and reports new version when newer available", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view returns newer
    mockExec.mockReturnValueOnce(undefined); // npm install succeeds
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n"); // npm root -g
    mockInstallSuccess();

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wasAlreadyLatest).toBe(false);
      expect(r.result.data.newVersion).toBe("0.2.0-beta.16");
      expect(r.result.data.humanHint).toContain("0.2.0-beta.16");
      expect(r.result.data.skills_refreshed).toBe(true);
    }
  });

  it("returns error when npm view fails", async () => {
    const h = home();
    mockExec.mockImplementationOnce(() => { throw new Error("network error"); });

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
  });

  it("returns error when npm install fails", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view succeeds
    mockExec.mockImplementationOnce(() => { throw new Error("permission denied"); }); // npm install fails

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
  });

  it("writes update cache after successful update", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallSuccess();

    await runUpdate({ home: h, distTag: "latest" });
    const cache = JSON.parse(readFileSync(cachePath(h), "utf8"));
    expect(cache.latestVersion).toBe("0.2.0-beta.16");
    expect(cache.distTag).toBe("latest");
    expect(cache.updateAppliedAt).toBeDefined();
  });

  it("uses and persists custom distTag in npm commands", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view skillwiki@beta version
    mockExec.mockReturnValueOnce(undefined); // npm install -g skillwiki@beta
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n"); // npm root -g
    mockInstallSuccess();

    const r = await runUpdate({ home: h, distTag: "beta" });
    expect(r.exitCode).toBe(0);
    expect(mockExec).toHaveBeenCalledWith(
      "npm view skillwiki@beta version",
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "npm install -g skillwiki@beta",
      expect.any(Object),
    );
    const cache = JSON.parse(readFileSync(cachePath(h), "utf8"));
    expect(cache.distTag).toBe("beta");
  });

  it("sets previousVersion to current version in both code paths", async () => {
    const h = home();
    // Already-latest path
    mockExec.mockReturnValueOnce(`${currentVersion}\n`);
    const r1 = await runUpdate({ home: h, distTag: "latest" });
    if (r1.result.ok) {
      expect(r1.result.data.previousVersion).toBe(currentVersion);
    }
    // Update path
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallSuccess();
    const r2 = await runUpdate({ home: h, distTag: "latest" });
    if (r2.result.ok) {
      expect(r2.result.data.previousVersion).toBe(currentVersion);
    }
  });

  it("writes update cache even when already latest", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`);

    await runUpdate({ home: h, distTag: "latest" });
    const cache = JSON.parse(readFileSync(cachePath(h), "utf8"));
    expect(cache.latestVersion).toBe(currentVersion);
    expect(cache.updateAppliedAt).toBeUndefined();
  });

  // --- New tests for version-aware skill refresh ---

  it("calls runInstall with correct target after npm update", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view
    mockExec.mockReturnValueOnce(undefined); // npm install
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n"); // npm root -g
    mockInstallSuccess();

    await runUpdate({ home: h, distTag: "latest" });

    expect(mockInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsRoot: join("/usr/local/lib/node_modules/skillwiki/skills"),
        target: join(h, ".claude", "skills"),
        dryRun: false,
        symlink: false,
        home: h,
        force: false,
      }),
    );
  });

  it("includes version_warnings from install in UpdateOutput", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallSuccess(["wiki-old: DEPRECATED — will be removed in a future release", "wiki-init: version changed 0.2.0 → 0.3.0"]);

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.version_warnings).toHaveLength(2);
      expect(r.result.data.version_warnings[0]).toContain("DEPRECATED");
      expect(r.result.data.version_warnings[1]).toContain("version changed");
      expect(r.result.data.skills_refreshed).toBe(true);
    }
  });

  it("reports skills_refreshed false when npm root -g fails", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view
    mockExec.mockReturnValueOnce(undefined); // npm install
    mockExec.mockImplementationOnce(() => { throw new Error("npm root failed"); }); // npm root -g

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.skills_refreshed).toBe(false);
      expect(r.result.data.version_warnings.length).toBeGreaterThan(0);
      expect(r.result.data.version_warnings[0]).toContain("could not locate global skillwiki");
    }
  });

  it("handles install refresh failure gracefully", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallFailure("PREFLIGHT_FAILED");

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0); // npm update itself succeeded
    if (r.result.ok) {
      expect(r.result.data.skills_refreshed).toBe(false);
      expect(r.result.data.version_warnings.some(w => w.includes("skill refresh failed"))).toBe(true);
    }
  });

  it("humanHint includes skill refresh info", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallSuccess();

    const r = await runUpdate({ home: h, distTag: "latest" });
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("skills refreshed: true");
    }
  });

  it("humanHint includes version warnings count when present", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n");
    mockInstallSuccess(["wiki-init: version changed 0.2.0 → 0.3.0"]);

    const r = await runUpdate({ home: h, distTag: "latest" });
    if (r.result.ok) {
      expect(r.result.data.humanHint).toContain("version warnings: 1");
      expect(r.result.data.humanHint).toContain("version changed");
    }
  });

  it("does not call runInstall when already latest", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`);

    await runUpdate({ home: h, distTag: "latest" });

    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("defaults to latest distTag when not specified", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`); // npm view

    await runUpdate({ home: h }); // no distTag

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("skillwiki@latest"),
      expect.any(Object),
    );
  });

  it("does not call npm install when already on latest", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`); // npm view only

    await runUpdate({ home: h, distTag: "latest" });

    // Only npm view should be called, no npm install
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith(
      "npm view skillwiki@latest version",
      expect.any(Object),
    );
  });

  it("handles runInstall throwing an exception gracefully", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view
    mockExec.mockReturnValueOnce(undefined); // npm install
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n"); // npm root -g
    mockInstall.mockRejectedValueOnce(new Error("install crashed"));

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0); // npm update itself succeeded
    if (r.result.ok) {
      expect(r.result.data.skills_refreshed).toBe(false);
      expect(r.result.data.version_warnings.some(w => w.includes("skill refresh error"))).toBe(true);
    }
  });

  it("reports deferred_to_plugin when plugin channel absorbs skill refresh", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view
    mockExec.mockReturnValueOnce(undefined); // npm install
    mockExec.mockReturnValueOnce("/usr/local/lib/node_modules\n"); // npm root -g
    mockInstallSuccess([], true); // deferred_to_plugin: true

    const r = await runUpdate({ home: h, distTag: "latest" });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.deferred_to_plugin).toBe(true);
      // refreshed is false because the plugin channel handled skills
      expect(r.result.data.skills_refreshed).toBe(false);
      expect(r.result.data.humanHint).toContain("deferred to plugin");
    }
  });
});
