import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateHelperPaths,
  resolveVaultSyncPullHelper,
} from "../../src/utils/vault-sync-helper.js";

describe("vault-sync helper resolution", () => {
  it("resolves the monorepo helper path when present", () => {
    const path = resolveVaultSyncPullHelper({ vault: process.cwd() });
    expect(path).toBeTruthy();
    expect(path).toMatch(/wiki-pull-with-auto-resolve\.sh$/);
  });

  it("prefers an explicit helperPath when the file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-explicit-"));
    const helper = join(root, "custom-helper.sh");
    writeFileSync(helper, "#!/bin/bash\n");
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      helperPath: helper,
      // isolate from monorepo/host fallbacks
      moduleDir: join(root, "no-module"),
      home: join(root, "no-home"),
      env: {},
    });
    expect(path).toBe(helper);
  });

  it("prefers SKILLWIKI_VAULT_SYNC_PULL_HELPER when the file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-env-"));
    const helper = join(root, "env-helper.sh");
    writeFileSync(helper, "#!/bin/bash\n");
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      moduleDir: join(root, "no-module"),
      home: join(root, "no-home"),
      env: { SKILLWIKI_VAULT_SYNC_PULL_HELPER: helper },
    });
    expect(path).toBe(helper);
  });

  it("resolves packaged dist-adjacent layout (npm install shape)", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-dist-"));
    const dist = join(root, "dist");
    const scripts = join(dist, "vault-sync", "scripts");
    mkdirSync(scripts, { recursive: true });
    const helper = join(scripts, "wiki-pull-with-auto-resolve.sh");
    writeFileSync(helper, "#!/bin/bash\n");
    // Simulate import.meta.url for dist/cli.js
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      moduleDir: dist,
      home: join(root, "empty-home"),
      env: {},
    });
    expect(path).toBe(helper);
  });

  it("falls back to macOS host install under Application Support", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-host-mac-"));
    const hostBin = join(root, "Library", "Application Support", "vault-sync", "bin");
    mkdirSync(hostBin, { recursive: true });
    const helper = join(hostBin, "wiki-pull-with-auto-resolve.sh");
    writeFileSync(helper, "#!/bin/bash\n");
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      moduleDir: join(root, "no-module"),
      home: root,
      env: {},
    });
    expect(path).toBe(helper);
  });

  it("falls back to XDG/Linux host install under .local/share", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-host-linux-"));
    const hostBin = join(root, ".local", "share", "vault-sync", "bin");
    mkdirSync(hostBin, { recursive: true });
    const helper = join(hostBin, "wiki-pull-with-auto-resolve.sh");
    writeFileSync(helper, "#!/bin/bash\n");
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      moduleDir: join(root, "no-module"),
      home: root,
      env: { XDG_DATA_HOME: undefined },
    });
    expect(path).toBe(helper);
  });

  it("returns null when no candidates exist", () => {
    const root = mkdtempSync(join(tmpdir(), "helper-none-"));
    const path = resolveVaultSyncPullHelper({
      vault: process.cwd(),
      moduleDir: join(root, "no-module"),
      home: join(root, "empty-home"),
      env: {},
    });
    expect(path).toBeNull();
  });

  it("includes dist-adjacent candidate first among module-relative paths", () => {
    const here = "/opt/homebrew/lib/node_modules/skillwiki/dist";
    const cands = candidateHelperPaths({
      vault: "",
      moduleDir: here,
      home: "/tmp/no-home-for-order-test",
      env: {},
    });
    expect(cands[0]).toBe(join(here, "vault-sync", "scripts", "wiki-pull-with-auto-resolve.sh"));
  });
});
