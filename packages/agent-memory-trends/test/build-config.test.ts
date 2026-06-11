import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("agent-memory-trends build config", () => {
  it("defines the CLI shebang in exactly one place", () => {
    const cliSource = readFileSync(join(packageRoot, "src", "cli.ts"), "utf8");
    const tsupConfig = readFileSync(join(packageRoot, "tsup.config.ts"), "utf8");

    const sourceHasShebang = cliSource.startsWith("#!/usr/bin/env node");
    const configInjectsShebang = /banner:\s*\{\s*js:\s*["']#!\/usr\/bin\/env node/.test(tsupConfig);

    expect(Number(sourceHasShebang) + Number(configInjectsShebang)).toBe(1);
  });

  it("builds the private package before runtime command scripts invoke dist", () => {
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const scriptName of ["doctor", "collect", "daily", "publish"]) {
      expect(packageJson.scripts[scriptName]).toContain("npm run --silent build");
      expect(packageJson.scripts[scriptName]).toContain(`node dist/cli.js ${scriptName}`);
    }
  });
});
