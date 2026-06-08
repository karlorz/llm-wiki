import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { packageJsonCandidateUrls, readCliPackageJson } from "../../src/utils/package-info.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(__dirname, "../..");
const currentVersion = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")).version;

describe("package-info", () => {
  it("reads the CLI package version from the source layout", () => {
    expect(readCliPackageJson().version).toBe(currentVersion);
  });

  it("includes the source-layout package.json candidate", () => {
    const baseUrl = pathToFileURL(join(cliRoot, "src", "utils", "package-info.ts")).href;
    const candidates = packageJsonCandidateUrls(baseUrl).map(url => fileURLToPath(url));
    expect(candidates).toContain(join(cliRoot, "package.json"));
  });

  it("includes the bundled npm-layout package.json candidate", () => {
    const baseUrl = pathToFileURL(join(cliRoot, "dist", "cli.js")).href;
    const candidates = packageJsonCandidateUrls(baseUrl).map(url => fileURLToPath(url));
    expect(candidates).toContain(join(cliRoot, "package.json"));
  });
});
