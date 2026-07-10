import { describe, it, expect } from "vitest";
import {
  PKG_NAME,
  DIST_TAG,
  CACHE_FILENAME,
  CHECK_INTERVAL_MS,
  VIEW_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  BG_SCRIPT_TIMEOUT_MS,
  AUTO_APPLY_DELAY_MS,
  ENV_DISABLE_KEY,
  CLI_DISABLE_FLAG,
  normalizeDistTag,
} from "../../src/utils/update-consts.js";

describe("update-consts", () => {
  it("exports PKG_NAME as skillwiki", () => {
    expect(PKG_NAME).toBe("skillwiki");
  });

  it("exports DIST_TAG as latest", () => {
    expect(DIST_TAG).toBe("latest");
  });

  it("exports CACHE_FILENAME", () => {
    expect(CACHE_FILENAME).toBe(".update-cache.json");
  });

  it("exports CHECK_INTERVAL_MS as 24 hours", () => {
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("exports sensible timeout values", () => {
    expect(VIEW_TIMEOUT_MS).toBe(15_000);
    expect(INSTALL_TIMEOUT_MS).toBe(60_000);
    expect(BG_SCRIPT_TIMEOUT_MS).toBe(30_000);
  });

  it("exports AUTO_APPLY_DELAY_MS as 6 hours", () => {
    expect(AUTO_APPLY_DELAY_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("exports disable flags", () => {
    expect(ENV_DISABLE_KEY).toBe("NO_UPDATE_NOTIFIER");
    expect(CLI_DISABLE_FLAG).toBe("--no-update-notifier");
  });

  it("normalizes unsafe or empty dist-tags to latest", () => {
    expect(normalizeDistTag("beta")).toBe("beta");
    expect(normalizeDistTag("next-2026.06")).toBe("next-2026.06");
    expect(normalizeDistTag(" beta ")).toBe("beta");
    expect(normalizeDistTag("beta && echo hacked")).toBe("latest");
    expect(normalizeDistTag("")).toBe("latest");
    expect(normalizeDistTag(undefined)).toBe("latest");
  });
});
