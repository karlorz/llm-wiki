import { describe, expect, it } from "vitest";
import { defaultCopyStatusDeps } from "../../src/commands/copy-status.js";
import { composeCopyStatus } from "../../src/copy-status/copy-status.js";

describe("MCP S3 writable copy status", () => {
  it("marks readable S3 with a refused write as blocked", async () => {
    const deps = defaultCopyStatusDeps({ vault: "/unused", home: "/unused", s3Ok: true, s3Writable: false, s3WritableError: "S3_WRITE_FAILED" });
    const live = await deps.probeLive();
    const status = composeCopyStatus({ live, github: { unknown: true }, local: { unknown: true } });
    expect(status.live).toMatchObject({ state: "blocked", reachable: true, writable: false, blocked_reason: "s3_write_probe_failed" });
    expect(status.humanHint).toContain("MCP S3 write probe failed (S3_WRITE_FAILED)");
    expect(status.humanHint).not.toContain("MCP S3 ok");
  });

  it("names successful read and write checks", async () => {
    const deps = defaultCopyStatusDeps({ vault: "/unused", home: "/unused", s3Ok: true, s3Writable: true });
    expect(await deps.probeLive()).toEqual({ reachable: true, writable: true, detail: "MCP S3 readable and writable" });
  });

  it("preserves the connectivity-only caller", async () => {
    const deps = defaultCopyStatusDeps({ vault: "/unused", home: "/unused", s3Ok: true });
    expect(await deps.probeLive()).toEqual({ reachable: true, detail: "MCP S3 ok" });
  });

  it("keeps connectivity failure visible when the last write succeeded", async () => {
    const deps = defaultCopyStatusDeps({ vault: "/unused", home: "/unused", s3Ok: false, s3Writable: true });
    expect(await deps.probeLive()).toEqual({ reachable: false, detail: "MCP S3 not ok" });
  });
});
