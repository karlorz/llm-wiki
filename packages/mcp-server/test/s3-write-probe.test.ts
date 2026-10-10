import { afterEach, describe, expect, it, vi } from "vitest";
import { probeS3Writable, S3_WRITE_PROBE_INTERVAL_MS, startS3WritePulse, type S3WriteHealth } from "../src/s3-write-probe.js";
import { makeS3Store } from "./helpers.js";

function fixture() {
  const s3 = makeS3Store();
  return {
    ...s3,
    hostId: "sg01",
    putObject: vi.fn(s3.putObject),
    getObject: vi.fn(s3.getObject),
    deleteObject: vi.fn(async (path: string) => { s3.store.delete(path); }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("S3 write probe", () => {
  it("writes, reads, verifies, and deletes a unique non-page object", async () => {
    const deps = fixture();
    const result = await probeS3Writable(deps);
    expect(result.s3Writable).toBe(true);
    expect(result.s3WritableCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.s3WritableError).toBeUndefined();
    const [path, body] = deps.putObject.mock.calls[0];
    expect(path).toMatch(/^health\/probe\/sg01\/\d{4}-\d{2}-\d{2}T.*-[a-f0-9-]+\.tmp$/);
    expect(body.toString("utf8")).toMatch(/\d{4}-\d{2}-\d{2}T.* — [a-f0-9-]{36}$/);
    expect(deps.getObject).toHaveBeenCalledWith(path);
    expect(deps.deleteObject).toHaveBeenCalledWith(path);
    expect(deps.store.size).toBe(0);
    await probeS3Writable(deps);
    expect(deps.putObject.mock.calls[1][0]).not.toBe(path);
    expect(deps.putObject.mock.invocationCallOrder[0]).toBeLessThan(deps.getObject.mock.invocationCallOrder[0]);
    expect(deps.getObject.mock.invocationCallOrder[0]).toBeLessThan(deps.deleteObject.mock.invocationCallOrder[0]);
  });

  it("fails closed on write refusal while reads remain available", async () => {
    const deps = fixture();
    deps.putObject.mockRejectedValue(new Error("No writable volumes; private endpoint"));
    const result = await probeS3Writable(deps);
    expect(result).toMatchObject({ s3Writable: false, s3WritableError: "S3_WRITE_FAILED" });
    expect(result.s3WritableError).not.toContain("private endpoint");
    expect(deps.getObject).not.toHaveBeenCalled();
    expect(deps.deleteObject).toHaveBeenCalledOnce();
  });

  it.each(["missing", "mismatch", "read error"])("fails closed on %s read-back and cleans up", async (mode) => {
    const deps = fixture();
    if (mode === "missing") deps.getObject.mockResolvedValue(null);
    if (mode === "mismatch") deps.getObject.mockResolvedValue({ body: Buffer.from("different bytes") });
    if (mode === "read error") deps.getObject.mockRejectedValue(new Error("unreachable"));
    const result = await probeS3Writable(deps);
    expect(result.s3Writable).toBe(false);
    expect(result.s3WritableError).toBe(mode === "mismatch" ? "S3_VERIFY_FAILED" : "S3_READ_FAILED");
    expect(deps.deleteObject).toHaveBeenCalledOnce();
    expect(deps.store.size).toBe(0);
  });

  it("keeps verified writability when best-effort deletion fails", async () => {
    const deps = fixture();
    deps.deleteObject.mockRejectedValue(new Error("delete unavailable"));
    expect((await probeS3Writable(deps)).s3Writable).toBe(true);
    expect([...deps.store.keys()][0]).toMatch(/^health\/probe\/sg01\/.*\.tmp$/);
  });

  it("refuses an unavailable transport and unsafe host before writing", async () => {
    const deps = fixture();
    expect(await probeS3Writable({ ...deps, deleteObject: undefined })).toMatchObject({ s3Writable: false, s3WritableError: "S3_PROBE_UNAVAILABLE" });
    expect(await probeS3Writable({ ...deps, hostId: "../../concepts" })).toMatchObject({ s3Writable: false, s3WritableError: "S3_PROBE_INVALID_HOST" });
    expect(deps.putObject).not.toHaveBeenCalled();
  });
});

describe("10-minute S3 pulse", () => {
  it("starts fail-closed, probes immediately, records failure and recovery, and stops", async () => {
    vi.useFakeTimers();
    const deps = fixture();
    const health: S3WriteHealth = {};
    const stop = startS3WritePulse(deps, health);
    try {
      expect(health).toMatchObject({ s3Writable: false, s3WritableError: "S3_PROBE_PENDING" });
      await vi.advanceTimersByTimeAsync(0);
      expect(health.s3Writable).toBe(true);
      deps.putObject.mockRejectedValueOnce(new Error("no volumes"));
      await vi.advanceTimersByTimeAsync(S3_WRITE_PROBE_INTERVAL_MS - 1);
      expect(deps.putObject).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(health).toMatchObject({ s3Writable: false, s3WritableError: "S3_WRITE_FAILED" });
      await vi.advanceTimersByTimeAsync(S3_WRITE_PROBE_INTERVAL_MS);
      expect(health.s3Writable).toBe(true);
      expect(health.s3WritableError).toBeUndefined();
      stop();
      await vi.advanceTimersByTimeAsync(S3_WRITE_PROBE_INTERVAL_MS);
      expect(deps.putObject).toHaveBeenCalledTimes(3);
    } finally { stop(); }
  });

  it("skips overlapping probes and ignores completion after stop", async () => {
    vi.useFakeTimers();
    const deps = fixture();
    let release!: () => void;
    deps.putObject.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const health: S3WriteHealth = {};
    const stop = startS3WritePulse(deps, health);
    try {
      await vi.advanceTimersByTimeAsync(S3_WRITE_PROBE_INTERVAL_MS * 2);
      expect(deps.putObject).toHaveBeenCalledOnce();
      stop();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(health.s3Writable).toBe(false);
    } finally { stop(); }
  });
});
