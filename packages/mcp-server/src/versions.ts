import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isS3Failure, S3PutError, writeAtomicPath } from "./txn.js";

export type HeadObject = (relPath: string) => Promise<{ etag?: string; sha256?: string; body?: Buffer } | null>;

export type GetObject = (relPath: string) => Promise<{ sha256?: string; body?: Buffer } | null>;

export interface S3Adapter {
  getObject: GetObject;
  putObject: (relPath: string, body: Buffer) => Promise<void>;
}

export interface VersionDeps {
  vaultDir: string;
  getObject?: GetObject;
}

export interface VersionResult {
  sha256: string;
  absent: boolean;
  bytes?: Buffer;
}

/**
 * Fetch S3 object version and compare to working copy.
 * If working copy differs from S3, refreshes that single path in the working copy.
 * If S3 is unreachable, throws S3PutError (or original S3 failure with code S3_PUT_FAILED).
 */
export async function currentVersion(deps: VersionDeps, relPath: string): Promise<VersionResult> {
  const target = join(deps.vaultDir, ...relPath.split("/"));

  if (!deps.getObject) {
    // Fallback when no getter is provided (e.g. unit tests without S3)
    if (!existsSync(target)) {
      return { sha256: "absent", absent: true };
    }
    const localBytes = await readFile(target);
    return {
      sha256: createHash("sha256").update(localBytes).digest("hex"),
      absent: false,
      bytes: localBytes,
    };
  }

  let s3Res: { sha256?: string; body?: Buffer } | null;
  try {
    s3Res = await deps.getObject(relPath);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw isS3Failure(error) ? error : new S3PutError(message, error);
  }

  if (!s3Res || !s3Res.body) {
    return { sha256: "absent", absent: true };
  }

  const s3Bytes = s3Res.body;
  const s3Sha256 = s3Res.sha256 ?? createHash("sha256").update(s3Bytes).digest("hex");

  // Compare to working copy bytes
  let localSha256: string | null = null;
  if (existsSync(target)) {
    try {
      const localBytes = await readFile(target);
      localSha256 = createHash("sha256").update(localBytes).digest("hex");
    } catch {
      localSha256 = null;
    }
  }

  if (localSha256 !== s3Sha256) {
    // Refresh this one path in working copy using atomic temp + rename
    await writeAtomicPath(target, s3Bytes);
  }

  return {
    sha256: s3Sha256,
    absent: false,
    bytes: s3Bytes,
  };
}
