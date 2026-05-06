import { describe, it, expect, vi } from "vitest";
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

import { execSync } from "node:child_process";
const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const currentVersion = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8")
).version;

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "update-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("runUpdate", () => {
  it("reports already latest when versions match", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`); // npm view returns current version

    const r = await runUpdate({ home: h, distTag: "beta" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wasAlreadyLatest).toBe(true);
      expect(r.result.data.newVersion).toBeNull();
    }
  });

  it("updates and reports new version when newer available", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view returns newer
    mockExec.mockReturnValueOnce(undefined); // npm install succeeds

    const r = await runUpdate({ home: h, distTag: "beta" });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      expect(r.result.data.wasAlreadyLatest).toBe(false);
      expect(r.result.data.newVersion).toBe("0.2.0-beta.16");
      expect(r.result.data.humanHint).toContain("0.2.0-beta.16");
    }
  });

  it("returns error when npm view fails", async () => {
    const h = home();
    mockExec.mockImplementationOnce(() => { throw new Error("network error"); });

    const r = await runUpdate({ home: h, distTag: "beta" });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
  });

  it("returns error when npm install fails", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n"); // npm view succeeds
    mockExec.mockImplementationOnce(() => { throw new Error("permission denied"); }); // npm install fails

    const r = await runUpdate({ home: h, distTag: "beta" });
    expect(r.exitCode).toBe(13); // PREFLIGHT_FAILED
    expect(r.result.ok).toBe(false);
  });

  it("writes update cache after successful update", async () => {
    const h = home();
    mockExec.mockReturnValueOnce("0.2.0-beta.16\n");
    mockExec.mockReturnValueOnce(undefined);

    await runUpdate({ home: h, distTag: "beta" });
    const cache = JSON.parse(readFileSync(cachePath(h), "utf8"));
    expect(cache.latestVersion).toBe("0.2.0-beta.16");
    expect(cache.updateAppliedAt).toBeDefined();
  });

  it("writes update cache even when already latest", async () => {
    const h = home();
    mockExec.mockReturnValueOnce(`${currentVersion}\n`);

    await runUpdate({ home: h, distTag: "beta" });
    const cache = JSON.parse(readFileSync(cachePath(h), "utf8"));
    expect(cache.latestVersion).toBe(currentVersion);
    expect(cache.updateAppliedAt).toBeUndefined();
  });
});
