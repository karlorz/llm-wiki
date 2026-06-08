import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPlugin, findPluginInstallations } from "../../src/utils/plugin-registry.js";

function makeHome(registryJson?: string): string {
  const home = mkdtempSync(join(tmpdir(), "plugin-reg-"));
  const pluginsDir = join(home, ".claude", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  if (registryJson !== undefined) {
    writeFileSync(join(pluginsDir, "installed_plugins.json"), registryJson);
  }
  return home;
}

const VALID_ENTRY = {
  scope: "user",
  installPath: "/some/path",
  version: "1.0.0",
  installedAt: "2026-01-01T00:00:00Z",
  lastUpdated: "2026-01-02T00:00:00Z",
};

describe("findPlugin", () => {
  it("returns null when home directory does not exist", () => {
    const result = findPlugin("/no/such/home/directory");
    expect(result).toBeNull();
  });

  it("returns null when registry file is missing", () => {
    const home = makeHome(); // no registryJson passed
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when registry file contains malformed JSON", () => {
    const home = makeHome("not valid json {{{");
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when registry has no plugins field", () => {
    const home = makeHome(JSON.stringify({ version: 1 }));
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when plugins object is empty", () => {
    const home = makeHome(JSON.stringify({ version: 1, plugins: {} }));
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when the specified key does not exist", () => {
    const home = makeHome(
      JSON.stringify({ version: 1, plugins: { "other@plugin": [VALID_ENTRY] } }),
    );
    const result = findPlugin(home, "skillwiki@llm-wiki");
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when the key exists but entries array is empty", () => {
    const home = makeHome(
      JSON.stringify({ version: 1, plugins: { "skillwiki@llm-wiki": [] } }),
    );
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the first install entry using the default key", () => {
    const second = { ...VALID_ENTRY, version: "2.0.0" };
    const home = makeHome(
      JSON.stringify({
        version: 1,
        plugins: { "skillwiki@llm-wiki": [VALID_ENTRY, second] },
      }),
    );
    const result = findPlugin(home);
    expect(result).not.toBeNull();
    expect(result!.version).toBe("1.0.0");
    expect(result!.scope).toBe("user");
    expect(result!.installPath).toBe("/some/path");
    expect(result!.installedAt).toBe("2026-01-01T00:00:00Z");
    expect(result!.lastUpdated).toBe("2026-01-02T00:00:00Z");
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the first install entry using a custom key", () => {
    const home = makeHome(
      JSON.stringify({
        version: 1,
        plugins: { "my-plugin@channel": [VALID_ENTRY] },
      }),
    );
    const result = findPlugin(home, "my-plugin@channel");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("1.0.0");
    rmSync(home, { recursive: true, force: true });
  });

  it("returns entry with optional gitCommitSha when present", () => {
    const entry = { ...VALID_ENTRY, gitCommitSha: "abc123" };
    const home = makeHome(
      JSON.stringify({
        version: 1,
        plugins: { "skillwiki@llm-wiki": [entry] },
      }),
    );
    const result = findPlugin(home);
    expect(result).not.toBeNull();
    expect(result!.gitCommitSha).toBe("abc123");
    rmSync(home, { recursive: true, force: true });
  });

  it("returns entry without gitCommitSha when omitted", () => {
    const home = makeHome(
      JSON.stringify({
        version: 1,
        plugins: { "skillwiki@llm-wiki": [VALID_ENTRY] },
      }),
    );
    const result = findPlugin(home);
    expect(result).not.toBeNull();
    expect(result!.gitCommitSha).toBeUndefined();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null when registry file is valid JSON but not an object", () => {
    const home = makeHome("42");
    const result = findPlugin(home);
    expect(result).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("findPluginInstallations", () => {
  it("returns enabled Codex plugin cache installation", () => {
    const home = makeHome();
    const cacheDir = join(home, ".codex", "plugins", "cache", "llm-wiki", "skillwiki", "0.8.4");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `
[plugins."skillwiki@llm-wiki"]
enabled = true

[marketplaces.llm-wiki]
source_type = "local"
source = "/repo/llm-wiki"
`);

    const result = findPluginInstallations(home);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channel: "codex",
      label: "Codex",
      pluginName: "skillwiki",
      marketplace: "llm-wiki",
      version: "0.8.4",
      installPath: cacheDir,
      sourceType: "local",
      source: "/repo/llm-wiki",
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("ignores Codex plugin cache when plugin is disabled", () => {
    const home = makeHome();
    mkdirSync(join(home, ".codex", "plugins", "cache", "llm-wiki", "skillwiki", "0.8.4"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `
[plugins."skillwiki@llm-wiki"]
enabled = false
`);

    expect(findPluginInstallations(home)).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("returns Claude and Codex installations together", () => {
    const home = makeHome(
      JSON.stringify({
        version: 1,
        plugins: { "skillwiki@llm-wiki": [VALID_ENTRY] },
      }),
    );
    mkdirSync(join(home, ".codex", "plugins", "cache", "llm-wiki", "skillwiki", "0.8.4"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), `
[plugins."skillwiki@llm-wiki"]
enabled = true
`);

    const channels = findPluginInstallations(home).map(plugin => plugin.channel);

    expect(channels).toEqual(["claude", "codex"]);
    rmSync(home, { recursive: true, force: true });
  });
});
