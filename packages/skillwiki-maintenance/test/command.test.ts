import { describe, it, expect } from "vitest";
import { createCommandRunner } from "../src/command.js";

describe("command runner", () => {
  it("runs a command and returns stdout", async () => {
    const runner = createCommandRunner();
    const result = await runner("node", ["-e", "process.stdout.write('platform-ok')"], {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("platform-ok");
  });

  it("propagates non-zero exit codes", async () => {
    const runner = createCommandRunner();
    const result = await runner("node", ["-e", "process.exit(7)"], {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(7);
  });
});