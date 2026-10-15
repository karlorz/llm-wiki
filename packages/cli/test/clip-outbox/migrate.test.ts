import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateClipOutbox, refreshInstalledClipPlist, stableCliBinary } from "../../src/clip-outbox/migrate.js";
import { runClipOutboxWatch } from "../../src/commands/clip-outbox.js";
import { clipFixture } from "./fixture.js";

describe("attended clip migration", () => {
  it("refreshes the packaged plist with configured root and Homebrew binary, without enabling or loading", async () => {
    const { home, map } = await clipFixture();
    map["clip_outbox.enabled"] = "false";
    const env = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n");
    await writeFile(join(home, ".skillwiki/.env"), env);
    const launch = vi.fn();
    const result = await migrateClipOutbox({ home, platform: "darwin", binaryPath: "/opt/homebrew/bin/skillwiki", nodePath: "/opt/homebrew/bin/node", launch });
    const plist = await readFile(result.plistPath, "utf8");
    expect(plist).toContain("/opt/homebrew/bin/skillwiki");
    expect(plist).toContain("/opt/homebrew/bin/node");
    expect(plist).toContain(`${home}/Obsidian/clip-outbox`);
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).not.toContain("@OUTBOX_ROOT@");
    expect(result.loaded).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(await readFile(join(home, ".skillwiki/.env"), "utf8")).toBe(env);
    await writeFile(result.plistPath, "stale /usr/local/bin/skillwiki");
    await migrateClipOutbox({ home, platform: "darwin", binaryPath: "/opt/homebrew/bin/skillwiki", launch });
    expect(await readFile(result.plistPath, "utf8")).not.toContain("/usr/local/bin");
    expect(launch).not.toHaveBeenCalled();
    await rm(home, { recursive: true });
  });
  it("never loads without both existing enablement and operator attestation", async () => {
    const { home } = await clipFixture();
    const launch = vi.fn();
    const args = { home, platform: "darwin", binaryPath: "/opt/homebrew/bin/skillwiki", load: true, launch };
    await expect(migrateClipOutbox(args)).rejects.toThrow(/conditional-create-proven/);
    await writeFile(join(home, ".skillwiki/.env"), "clip_outbox.enabled=false\n");
    await expect(migrateClipOutbox({ ...args, conditionalCreateProven: true })).rejects.toThrow(/enabled=true/);
    expect(launch).not.toHaveBeenCalled();
    const result = await runClipOutboxWatch(home);
    expect(result.exitCode).not.toBe(0);
    expect(JSON.stringify(result)).toContain("clip channel not configured");
    await rm(home, { recursive: true });
  });
  it("refreshes an existing plist on upgrade and no-ops when absent", async () => {
    const { home } = await clipFixture();
    const args = { platform: "darwin" as const, binaryPath: "/opt/homebrew/bin/skillwiki", nodePath: "/opt/homebrew/bin/node" };
    expect(await refreshInstalledClipPlist(home, args)).toBeUndefined();
    const installed = await migrateClipOutbox({ home, ...args });
    await writeFile(installed.plistPath, "stale /usr/local/bin/skillwiki");
    const hint = await refreshInstalledClipPlist(home, args);
    expect(hint).toMatch(/clip launchd plist/);
    expect(await readFile(installed.plistPath, "utf8")).toContain("/opt/homebrew/bin/skillwiki");
    expect(await readFile(installed.plistPath, "utf8")).not.toContain("/usr/local/bin");
    await rm(home, { recursive: true });
  });
  it("preserves the npm bin symlink path instead of resolving a version-specific target", async () => {
    const { home } = await clipFixture();
    const binary = join(home, "bin/skillwiki");
    await mkdir(join(home, "bin"));
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    expect(await stableCliBinary(binary)).toBe(binary);
    await rm(home, { recursive: true });
  });
});
