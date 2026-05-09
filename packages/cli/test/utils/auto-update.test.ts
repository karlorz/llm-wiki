import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, needsCheck, latestFromCache, cachePath, triggerAutoUpdate } from "../../src/utils/auto-update.js";

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "autoupdate-home-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  return h;
}

describe("auto-update utilities", () => {
  it("readCache returns null cache when no cache file exists", () => {
    const h = home();
    const result = readCache(h);
    expect(result.cache).toBeNull();
    expect(result.isStale).toBe(true);
    expect(result.hasUpdate).toBe(false);
  });

  it("writeCache + readCache round-trips correctly", () => {
    const h = home();
    const cache = { lastCheck: 1234567890, latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15" };
    writeCache(h, cache);
    const result = readCache(h);
    expect(result.cache).toEqual(cache);
    expect(result.isStale).toBe(true); // old timestamp >24h ago
    expect(result.hasUpdate).toBe(true); // beta.16 > beta.15
  });

  it("needsCheck returns true when no cache exists", () => {
    const h = home();
    expect(needsCheck(h)).toBe(true);
  });

  it("needsCheck returns false when cache is fresh (<24h)", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15" });
    expect(needsCheck(h)).toBe(false);
  });

  it("needsCheck returns true when cache is stale (>24h)", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now() - 25 * 60 * 60 * 1000, latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15" });
    expect(needsCheck(h)).toBe(true);
  });

  it("latestFromCache returns hasUpdate=false when no cache", () => {
    const h = home();
    expect(latestFromCache(h, "0.2.0-beta.15")).toEqual({ hasUpdate: false, latest: null });
  });

  it("latestFromCache returns hasUpdate=true when newer version cached", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15" });
    const result = latestFromCache(h, "0.2.0-beta.15");
    expect(result.hasUpdate).toBe(true);
    expect(result.latest).toBe("0.2.0-beta.16");
  });

  it("latestFromCache returns hasUpdate=false when on same version", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.15", currentVersion: "0.2.0-beta.15" });
    const result = latestFromCache(h, "0.2.0-beta.15");
    expect(result.hasUpdate).toBe(false);
  });

  it("cachePath resolves to ~/.skillwiki/.update-cache.json", () => {
    expect(cachePath("/home/user")).toBe(join("/home/user", ".skillwiki", ".update-cache.json"));
  });

  it("triggerAutoUpdate respects NO_UPDATE_NOTIFIER env var", () => {
    const orig = process.env.NO_UPDATE_NOTIFIER;
    process.env.NO_UPDATE_NOTIFIER = "1";
    // Should not throw — exits early before spawn
    triggerAutoUpdate("/tmp", "0.2.0-beta.15");
    if (orig === undefined) delete process.env.NO_UPDATE_NOTIFIER;
    else process.env.NO_UPDATE_NOTIFIER = orig;
  });

  it("triggerAutoUpdate respects NODE_ENV=test", () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    triggerAutoUpdate("/tmp", "0.2.0-beta.15");
    if (orig === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = orig;
  });
});
