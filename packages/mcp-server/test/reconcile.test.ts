import { describe, expect, it } from "vitest";
import {
  DEFAULT_RCLONE_COPY_TIMEOUT_MS,
  rcloneCopyUpdate,
  ReconcileGate,
  ToolsNotReadyError,
} from "../src/reconcile.js";

describe("reconcile gate", () => {
  it("blocks tools until the first inbound copy completes", async () => {
    let resolveCopy!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
    const gate = new ReconcileGate(async () => {
      await started;
    });
    expect(gate.ready).toBe(false);
    expect(() => gate.assertReady()).toThrow(ToolsNotReadyError);
    const first = gate.runFirst();
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.ready).toBe(false);
    resolveCopy();
    await first;
    expect(gate.ready).toBe(true);
    expect(() => gate.assertReady()).not.toThrow();
  });
});

describe("rcloneCopyUpdate timeout", () => {
  it("defaults longer than 120s so a ~20k-object inbound copy does not hard-abort", () => {
    expect(DEFAULT_RCLONE_COPY_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(DEFAULT_RCLONE_COPY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it("passes the configured timeout into the shipped execFile rclone copy --update", async () => {
    let captured: { file?: string; args?: readonly string[]; timeout?: number } = {};
    await rcloneCopyUpdate({
      remote: "seaweed-wiki",
      bucket: "cloud/wiki-dev",
      vaultDir: "/opt/skillwiki-mcp/vault",
      timeoutMs: 600_000,
      execFile: async (file, args, options) => {
        captured = { file, args, timeout: options.timeout };
        return { stdout: "", stderr: "" };
      },
    });
    expect(captured.file).toBe("rclone");
    expect(captured.args).toEqual(["copy", "--update", "seaweed-wiki:cloud/wiki-dev", "/opt/skillwiki-mcp/vault"]);
    expect(captured.timeout).toBe(600_000);
    expect(captured.timeout).not.toBe(120_000);
  });

  it("uses DEFAULT_RCLONE_COPY_TIMEOUT_MS when timeoutMs is omitted", async () => {
    let timeout: number | undefined;
    await rcloneCopyUpdate({
      remote: "seaweed-wiki",
      bucket: "cloud/wiki-dev",
      vaultDir: "/vault",
      execFile: async (_file, _args, options) => {
        timeout = options.timeout;
        return { stdout: "", stderr: "" };
      },
    });
    expect(timeout).toBe(DEFAULT_RCLONE_COPY_TIMEOUT_MS);
    expect(timeout).not.toBe(120_000);
  });
});
