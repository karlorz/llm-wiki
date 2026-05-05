// Auto-update constants shared across CLI and background script

export const PKG_NAME = "skillwiki";
export const DIST_TAG = "beta";
export const CACHE_FILENAME = ".update-cache.json";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const VIEW_TIMEOUT_MS = 15_000;
export const INSTALL_TIMEOUT_MS = 60_000;
export const BG_SCRIPT_TIMEOUT_MS = 30_000;

// Disable flags
export const ENV_DISABLE_KEY = "NO_UPDATE_NOTIFIER";
export const CLI_DISABLE_FLAG = "--no-update-notifier";
