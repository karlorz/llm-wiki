import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runConfigGet, runConfigPath } from "../../src/commands/config.js";
import { runConnect } from "../../src/commands/connect.js";
import { runDoctor } from "../../src/commands/doctor.js";

const temporaryHomes: string[] = [];
const plantedToken = "planted-windows-home-test-token";

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "windows-home-"));
  temporaryHomes.push(home);
  mkdirSync(join(home, ".skillwiki"));
  writeFileSync(join(home, ".skillwiki", ".env"), [
    "SKILLWIKI_HOST_ID=windows-home-fixture",
    "SKILLWIKI_MCP_URL=https://override.example.test/mcp",
    "WIKI_LANG=en",
    `SKILLWIKI_MCP_TOKEN=${plantedToken}`,
    "",
  ].join("\n"));
  return home;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Windows user config home", () => {
  it.each([undefined, "", "   "])("uses USERPROFILE when HOME is %j", async (homeValue) => {
    const home = makeHome();
    vi.stubEnv("HOME", homeValue);
    vi.stubEnv("USERPROFILE", home);
    const result = await runConfigPath({ home: "" });
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) return;
    expect(result.result.data.path).toBe(join(home, ".skillwiki", ".env"));
    expect(isAbsolute(result.result.data.path)).toBe(true);
    expect(result.result.data.exists).toBe(true);
    const configured = await runConfigGet({ home: "", key: "WIKI_LANG" });
    expect(configured.result.ok && configured.result.data.value).toBe("en");
  });

  it("doctor resolves injected Windows home and reports the absolute config path", async () => {
    const home = makeHome();
    const result = await runDoctor({
      home: "", env: { HOME: "", USERPROFILE: home }, envValue: undefined,
      argv: ["node", "cli.js"], currentVersion: "0.10.108", cwd: tmpdir(),
    });
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) return;
    const config = result.result.data.checks.find((check) => check.id === "config_file");
    expect(config?.status).toBe("pass");
    expect(config?.detail).toContain(join(home, ".skillwiki", ".env"));
    expect(JSON.stringify(result)).not.toContain(plantedToken);
  });

  it("connect dry-run uses USERPROFILE without writing relative credentials", async () => {
    const home = makeHome();
    const result = await runConnect({
      home: "", env: { HOME: "", USERPROFILE: home }, fromStdin: true,
      readStdin: async () => `SKILLWIKI_HOST_ID=windows-home-fixture\nSKILLWIKI_MCP_TOKEN=${plantedToken}\n`,
      dryRun: true, checkMcp: false, currentVersion: "0.10.108",
    });
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) return;
    expect(result.result.data.dest).toBe(join(home, ".skillwiki", ".env"));
    expect(result.result.data.written).toBe(false);
    expect(JSON.stringify(result)).not.toContain(plantedToken);
  });
});
