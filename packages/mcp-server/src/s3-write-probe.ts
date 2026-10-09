import { randomUUID } from "node:crypto";
import { sep } from "node:path";
import { writeTest } from "../../cli/src/utils/s3-mount-health.js";
import type { PutObject } from "./txn.js";
import type { GetObject } from "./versions.js";

export const S3_WRITE_PROBE_INTERVAL_MS = 10 * 60 * 1000;

export interface S3WriteHealth {
  s3Writable?: boolean;
  s3WritableCheckedAt?: string;
  s3WritableError?: string;
}

export interface S3WriteProbeDeps {
  hostId: string;
  putObject: PutObject;
  getObject?: GetObject;
  deleteObject?: (path: string) => Promise<void>;
}

export async function probeS3Writable(deps: S3WriteProbeDeps): Promise<S3WriteHealth> {
  const checkedAt = new Date().toISOString();
  const failed = (error: string): S3WriteHealth => ({
    s3Writable: false,
    s3WritableCheckedAt: checkedAt,
    s3WritableError: error,
  });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(deps.hostId)) {
    return failed("S3_PROBE_INVALID_HOST");
  }
  const { getObject, deleteObject } = deps;
  if (!getObject || !deleteObject) return failed("S3_PROBE_UNAVAILABLE");

  // The daemon working copy is local disk; verify through its S3 transport.
  const key = (path: string) => path.split(sep).join("/");
  try {
    const result = await writeTest(`health/probe/${deps.hostId}`, {
      fileName: `${checkedAt}-${randomUUID()}.tmp`,
      io: {
        write: (path, payload) => deps.putObject(key(path), Buffer.from(payload, "utf8")),
        read: async (path) => {
          const object = await getObject(key(path));
          if (!object?.body) throw new Error("probe object missing");
          return object.body.toString("utf8");
        },
        remove: (path) => deleteObject(key(path)),
      },
    });
    if (!result.success) {
      const error = result.error?.startsWith("write failed:") ? "S3_WRITE_FAILED"
        : result.error?.startsWith("read failed:") ? "S3_READ_FAILED"
        : "S3_VERIFY_FAILED";
      return failed(error);
    }
    return { s3Writable: true, s3WritableCheckedAt: checkedAt };
  } catch {
    return failed("S3_PROBE_FAILED");
  }
}

export function startS3WritePulse(deps: S3WriteProbeDeps, health: S3WriteHealth): () => void {
  let running = false;
  let stopped = false;
  health.s3Writable = false;
  health.s3WritableError = "S3_PROBE_PENDING";
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await probeS3Writable(deps);
      if (!stopped) {
        health.s3Writable = result.s3Writable;
        health.s3WritableCheckedAt = result.s3WritableCheckedAt;
        health.s3WritableError = result.s3WritableError;
      }
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, S3_WRITE_PROBE_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
