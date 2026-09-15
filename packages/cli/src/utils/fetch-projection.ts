import { isAbsolute, join, resolve } from "node:path";
import { readSkillWikiConfig } from "./snapshot-worktree.js";

export interface ConfiguredFetchProjection {
  configured: boolean;
  path?: string;
  invalidDetail?: string;
}

export function inspectConfiguredFetchProjection(home: string): ConfiguredFetchProjection {
  if (!home) return { configured: false };
  const config = readSkillWikiConfig(join(home, ".skillwiki", ".env"));
  const configured = config["vault_sync.fetch_projection"];
  if (!configured || configured === "none") return { configured: false };
  if (!isAbsolute(configured)) {
    return { configured: true, invalidDetail: "configured fetch projection path must be absolute" };
  }
  return { configured: true, path: resolve(configured) };
}

/** Resolve the leaf fetch projection without falling back to snapshotter state. */
export function resolveConfiguredFetchProjection(home: string): string | undefined {
  return inspectConfiguredFetchProjection(home).path;
}
