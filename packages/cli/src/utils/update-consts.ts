// Auto-update constants shared across CLI and background script

export const PKG_NAME = "skillwiki";
export const DIST_TAG = "latest";
export const CACHE_FILENAME = ".update-cache.json";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const VIEW_TIMEOUT_MS = 15_000;
export const INSTALL_TIMEOUT_MS = 60_000;
export const BG_SCRIPT_TIMEOUT_MS = 30_000;

// Disable flags
export const ENV_DISABLE_KEY = "NO_UPDATE_NOTIFIER";
export const CLI_DISABLE_FLAG = "--no-update-notifier";

export function normalizeDistTag(tag: string | undefined | null): string {
  const value = (tag ?? DIST_TAG).trim();
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : DIST_TAG;
}
