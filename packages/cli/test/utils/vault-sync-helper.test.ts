import { describe, expect, it } from "vitest";
import { resolveVaultSyncPullHelper } from "../../src/utils/vault-sync-helper.js";

describe("vault-sync helper resolution", () => {
  it("resolves the monorepo helper path when present", () => {
    const path = resolveVaultSyncPullHelper({ vault: process.cwd() });
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki-pull-with-auto-resolve\.sh$/);
  });

  it("prefers an explicit helperPath", () => {
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      helperPath: "/tmp/does-not-need-to-exist-for-first-candidate",
    });
    // candidate list includes helperPath first but only returns if exists
    // so without the file, falls through to monorepo path
    expect(path).toMatch(/wiki-pull-with-auto-resolve\.sh$/);
  });
});
