import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

describe("built maintenance CLI", () => {
  it("starts after a fresh build without resolving TypeScript workspace sources", () => {
    execFileSync("npm", ["run", "-w", "@skillwiki/maintenance", "--silent", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const result = spawnSync("node", ["packages/skillwiki-maintenance/dist/cli.js", "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Usage: skillwiki-maintenance");
    expect(output).not.toContain("ERR_UNKNOWN_FILE_EXTENSION");
    expect(output).not.toContain("agent-memory-trends/src");
  });
});
