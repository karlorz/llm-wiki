import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("esm production bundle", () => {
  it("loads without dynamic-require of node builtins", () => {
    execFileSync("npm", ["run", "build"], { cwd: pkgRoot, encoding: "utf8" });
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('./dist/server.js'); console.log('bundle_ok')"],
      { cwd: pkgRoot, encoding: "utf8", timeout: 20_000 },
    );
    expect(output).toContain("bundle_ok");
  });
});
