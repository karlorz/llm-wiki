import { describe, it, expect } from "vitest";
import { buildCliSurface } from "../../src/utils/cli-surface.js";
import { execSync } from "node:child_process";

/**
 * Drift-detection test: verify that buildCliSurface() covers all
 * top-level commands registered in the real CLI.
 *
 * This catches the case where someone adds a new command to cli.ts
 * but forgets to update cli-surface.ts.
 */
describe("cli-surface drift detection", () => {
  it("surface includes all top-level commands from the real CLI", () => {
    const surface = buildCliSurface();
    // Parse `skillwiki --help` output to get actual command names
    const helpOutput = execSync("node packages/cli/dist/cli.js --help", {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    // Extract command names from help output (lines like "  cmd          description")
    const commandRegex = /^\s+([a-z][a-z0-9-]+)/gm;
    const realCommands = new Set<string>();
    for (const m of helpOutput.matchAll(commandRegex)) {
      realCommands.add(m[1]!);
    }
    // Filter out "help" which is auto-added by Commander
    realCommands.delete("help");

    // Every real command should appear as a top-level key in the surface
    for (const cmd of realCommands) {
      expect(surface.has(cmd)).toBe(true);
    }
  });

  it("surface includes all subcommands from the real CLI", () => {
    const surface = buildCliSurface();
    const subcommandGroups = [
      { parent: "graph", subs: ["build"] },
      { parent: "canvas", subs: ["generate"] },
      { parent: "config", subs: ["get", "set", "list", "path"] },
      { parent: "compound", subs: ["promote", "list", "delete"] },
      { parent: "sync", subs: ["status", "push", "pull"] },
      { parent: "backup", subs: ["sync", "restore"] },
    ];

    for (const group of subcommandGroups) {
      for (const sub of group.subs) {
        const key = `${group.parent}.${sub}`;
        expect(surface.has(key)).toBe(true);
      }
    }
  });
});
