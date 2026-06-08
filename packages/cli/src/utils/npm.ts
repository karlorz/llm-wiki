import { execSync } from "node:child_process";
import { PKG_NAME, DIST_TAG, VIEW_TIMEOUT_MS, INSTALL_TIMEOUT_MS, normalizeDistTag } from "./update-consts.js";

export function npmViewVersion(tag: string = DIST_TAG): string {
  const safeTag = normalizeDistTag(tag);
  return execSync(`npm view ${PKG_NAME}@${safeTag} version`, {
    encoding: "utf8",
    timeout: VIEW_TIMEOUT_MS,
  }).trim();
}

export function npmInstallGlobal(tag: string = DIST_TAG, stdio: "ignore" | "pipe" = "ignore"): void {
  const safeTag = normalizeDistTag(tag);
  execSync(`npm install -g ${PKG_NAME}@${safeTag}`, {
    stdio,
    timeout: INSTALL_TIMEOUT_MS,
  });
}
