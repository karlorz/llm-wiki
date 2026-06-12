import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectCliInvocation } from "../src/cli.js";

describe("agent-memory-trends CLI entrypoint detection", () => {
  it("treats an npm bin symlink as a direct CLI invocation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-memory-trends-cli-entry-"));
    const realDir = join(root, "packages", "agent-memory-trends", "dist");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const realEntrypoint = join(realDir, "cli.js");
    const symlinkEntrypoint = join(binDir, "agent-memory-trends");
    writeFileSync(realEntrypoint, "#!/usr/bin/env node\n");
    symlinkSync(realEntrypoint, symlinkEntrypoint);

    expect(isDirectCliInvocation(pathToFileURL(realEntrypoint).href, symlinkEntrypoint)).toBe(true);
  });
});
