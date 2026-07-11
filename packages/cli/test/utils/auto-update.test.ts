import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, needsCheck, latestFromCache, cachePath, distTagFromCache, triggerAutoUpdate, resolveAutoApplyAt, formatCountdown, notifyPendingUpdate, type UpdateCache } from "../../src/utils/auto-update.js";
import { AUTO_APPLY_DELAY_MS } from "../../src/utils/update-consts.js";

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
    const cache = { lastCheck: 1234567890, latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15", distTag: "beta" };
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
    expect(latestFromCache(h, "0.2.0-beta.15")).toEqual({ hasUpdate: false, latest: null, distTag: "latest" });
  });

  it("latestFromCache returns hasUpdate=true when newer version cached", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15" });
    const result = latestFromCache(h, "0.2.0-beta.15");
    expect(result.hasUpdate).toBe(true);
    expect(result.latest).toBe("0.2.0-beta.16");
    expect(result.distTag).toBe("latest");
  });

  it("latestFromCache returns hasUpdate=false when on same version", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.15", currentVersion: "0.2.0-beta.15", distTag: "beta" });
    const result = latestFromCache(h, "0.2.0-beta.15");
    expect(result.hasUpdate).toBe(false);
    expect(result.distTag).toBe("beta");
  });

  it("cachePath resolves to ~/.skillwiki/.update-cache.json", () => {
    expect(cachePath("/home/user")).toBe(join("/home/user", ".skillwiki", ".update-cache.json"));
  });

  it("distTagFromCache returns cached background auto-update channel", () => {
    const h = home();
    writeCache(h, { lastCheck: Date.now() - 25 * 60 * 60 * 1000, latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15", distTag: "beta" });
    expect(distTagFromCache(h)).toBe("beta");
  });

  it("distTagFromCache defaults unsafe or missing cache channel to latest", () => {
    const h = home();
    expect(distTagFromCache(h)).toBe("latest");
    writeCache(h, { lastCheck: Date.now(), latestVersion: "0.2.0-beta.16", currentVersion: "0.2.0-beta.15", distTag: "beta && npm publish" });
    expect(distTagFromCache(h)).toBe("latest");
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

describe("resolveAutoApplyAt countdown", () => {
  it("stamps firstSeenAt + autoApplyAt when version is new", () => {
    const now = 1_000_000;
    const r = resolveAutoApplyAt(null, "0.9.55", now);
    expect(r.firstSeenAt).toBe(now);
    expect(r.autoApplyAt).toBe(now + AUTO_APPLY_DELAY_MS);
  });

  it("preserves existing firstSeenAt/autoApplyAt when version is unchanged", () => {
    const firstSeenAt = 1_000_000;
    const autoApplyAt = firstSeenAt + AUTO_APPLY_DELAY_MS;
    const cache = { lastCheck: firstSeenAt, latestVersion: "0.9.55", currentVersion: "0.9.37", firstSeenAt, autoApplyAt };
    const r = resolveAutoApplyAt(cache, "0.9.55", firstSeenAt + 60_000);
    expect(r.firstSeenAt).toBe(firstSeenAt);
    expect(r.autoApplyAt).toBe(autoApplyAt);
  });

  it("resets countdown when latest version changes", () => {
    const firstSeenAt = 1_000_000;
    const autoApplyAt = firstSeenAt + AUTO_APPLY_DELAY_MS;
    const cache = { lastCheck: firstSeenAt, latestVersion: "0.9.55", currentVersion: "0.9.37", firstSeenAt, autoApplyAt };
    const now = firstSeenAt + 7_200_000;
    const r = resolveAutoApplyAt(cache, "0.9.56", now);
    expect(r.firstSeenAt).toBe(now);
    expect(r.autoApplyAt).toBe(now + AUTO_APPLY_DELAY_MS);
  });

  it("resets countdown when prior cache lacks firstSeenAt", () => {
    const cache = { lastCheck: 1_000_000, latestVersion: "0.9.55", currentVersion: "0.9.37" };
    const now = 2_000_000;
    const r = resolveAutoApplyAt(cache, "0.9.55", now);
    expect(r.firstSeenAt).toBe(now);
    expect(r.autoApplyAt).toBe(now + AUTO_APPLY_DELAY_MS);
  });
});

describe("formatCountdown", () => {
  it("returns null when no autoApplyAt", () => {
    expect(formatCountdown(undefined)).toBeNull();
  });

  it("returns null when countdown has elapsed", () => {
    const now = 2_000_000;
    expect(formatCountdown(1_000_000, now)).toBeNull();
  });

  it("formats remaining hours and minutes", () => {
    const now = 1_000_000;
    // 5h 30m remaining
    const autoApplyAt = now + (5 * 60 + 30) * 60_000;
    expect(formatCountdown(autoApplyAt, now)).toBe("5h 30m");
  });

  it("formats minutes only when under an hour", () => {
    const now = 1_000_000;
    const autoApplyAt = now + 25 * 60_000;
    expect(formatCountdown(autoApplyAt, now)).toBe("25m");
  });
});

describe("notifyPendingUpdate", () => {
  // notifyPendingUpdate checks isDisabled(), which is true under NODE_ENV=test.
  // Unset it for these tests so the notify path is exercised.
  let origNodeEnv: string | undefined;
  beforeEach(() => {
    origNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
  });
  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
  });

  it("writes a stderr countdown line when an update is pending", () => {
    const firstSeenAt = Date.now();
    const cache: UpdateCache = {
      lastCheck: firstSeenAt,
      latestVersion: "0.9.60",
      currentVersion: "0.9.55",
      distTag: "latest",
      firstSeenAt,
      autoApplyAt: firstSeenAt + AUTO_APPLY_DELAY_MS,
    };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      notifyPendingUpdate(cache, "0.9.55");
      expect(spy).toHaveBeenCalled();
      const msg = spy.mock.calls[0][0].toString();
      expect(msg).toContain("0.9.55 -> 0.9.60");
      expect(msg).toMatch(/Auto-applying in \d+h \d+m|Auto-applying in \d+m/);
      expect(msg).toContain("NO_UPDATE_NOTIFIER=1");
    } finally {
      spy.mockRestore();
    }
  });

  it("is silent when no update is pending", () => {
    const now = Date.now();
    const cache: UpdateCache = { lastCheck: now, latestVersion: "0.9.55", currentVersion: "0.9.55", distTag: "latest" };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      notifyPendingUpdate(cache, "0.9.55");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("is silent when countdown has elapsed (apply will happen in background)", () => {
    const firstSeenAt = Date.now() - AUTO_APPLY_DELAY_MS - 60_000;
    const cache: UpdateCache = {
      lastCheck: firstSeenAt,
      latestVersion: "0.9.60",
      currentVersion: "0.9.55",
      distTag: "latest",
      firstSeenAt,
      autoApplyAt: firstSeenAt + AUTO_APPLY_DELAY_MS,
    };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      notifyPendingUpdate(cache, "0.9.55");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("is silent when latest is older than running (stale cache, no phantom downgrade)", () => {
    const firstSeenAt = Date.now();
    const cache: UpdateCache = {
      lastCheck: firstSeenAt,
      latestVersion: "0.9.39",
      currentVersion: "0.9.37",
      distTag: "latest",
      firstSeenAt,
      autoApplyAt: firstSeenAt + AUTO_APPLY_DELAY_MS,
    };
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      notifyPendingUpdate(cache, "0.9.55");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("respects NO_UPDATE_NOTIFIER", () => {
    const firstSeenAt = Date.now();
    const cache: UpdateCache = {
      lastCheck: firstSeenAt,
      latestVersion: "0.9.60",
      currentVersion: "0.9.55",
      distTag: "latest",
      firstSeenAt,
      autoApplyAt: firstSeenAt + AUTO_APPLY_DELAY_MS,
    };
    const orig = process.env.NO_UPDATE_NOTIFIER;
    process.env.NO_UPDATE_NOTIFIER = "1";
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      notifyPendingUpdate(cache, "0.9.55");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (orig === undefined) delete process.env.NO_UPDATE_NOTIFIER;
      else process.env.NO_UPDATE_NOTIFIER = orig;
    }
  });
});


describe("auto-update-bg dist artifact", () => {
  it("has exactly one shebang and is parseable by node --check", () => {
    // Drives the shipped dist entry (tsup banner + no source shebang).
    // Double shebang breaks Node ESM on Linux (sg01) with SyntaxError.
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const { resolve, dirname, join } = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    // Prefer built dist next to package
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const bg = join(pkgRoot, "dist", "auto-update-bg.js");
    expect(existsSync(bg)).toBe(true);
    const text = readFileSync(bg, "utf8");
    const shebangCount = (text.match(/^#!\/usr\/bin\/env node$/gm) ?? []).length;
    expect(shebangCount).toBe(1);
    // Second line must not be another shebang
    const lines = text.split(/\r?\n/);
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]?.startsWith("#!")).toBe(false);
    // Real Node parse (same failure mode as sg01)
    expect(() => execFileSync(process.execPath, ["--check", bg], { stdio: "pipe" })).not.toThrow();
  });
});
