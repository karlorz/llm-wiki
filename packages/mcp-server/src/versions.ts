import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isS3Failure, S3PutError, sha256Bytes, writeAtomicPath } from "./txn.js";

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
    try {
      const localBytes = await readFile(target);
      return { sha256: sha256Bytes(localBytes), absent: false, bytes: localBytes };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sha256: "absent", absent: true };
      }
      throw error;
    }
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
  const s3Sha256 = s3Res.sha256 ?? sha256Bytes(s3Bytes);

  let localBytes: Buffer | null = null;
  try {
    localBytes = await readFile(target);
  } catch {
    localBytes = null;
  }

  if (!localBytes || !localBytes.equals(s3Bytes)) {
    await writeAtomicPath(target, s3Bytes);
  }

  return {
    sha256: s3Sha256,
    absent: false,
    bytes: s3Bytes,
  };
}
