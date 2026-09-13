import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

export type PutObject = (relPath: string, body: Buffer) => Promise<void>;

export interface TxnFile {
  relPath: string;
  content: string;
}

export interface TxnDeps {
  vaultDir: string;
  putObject: PutObject;
  onCommit?: (paths: string[]) => void;
}

export interface FileChangedError {
  error: "FILE_CHANGED";
  currentVersion: string;
  path: string;
}

export function fileChangedError(path: string, currentSha256: string): FileChangedError {
  return {
    error: "FILE_CHANGED",
    currentVersion: `sha256:${currentSha256}`,
    path,
  };
}

let writeChain: Promise<unknown> = Promise.resolve();

export function withWriteMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function isS3Failure(error: unknown): error is Error & { code: string } {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "S3_PUT_FAILED");
}

export class S3PutError extends Error {
  readonly code = "S3_PUT_FAILED";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "S3PutError";
  }
}

async function writeTemp(target: string, content: string): Promise<string> {
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
  return tmp;
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function normalizeSha256(value: string): string {
  return value.trim().replace(/^sha256:/i, "").toLowerCase();
}

export type CasCommitResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: "FILE_CHANGED"; currentVersion: string; path: string }
  | { ok: false; error: "USAGE"; message: string };

/**
 * CAS overwrite/create inside the write mutex. `expectedSha256` omitted/empty
 * requires the path to be absent. A hex (optionally `sha256:` prefixed) value
 * requires a matching current file.
 */
export async function commitCasWrite(
  deps: TxnDeps,
  file: TxnFile,
  expectedSha256?: string,
): Promise<CasCommitResult> {
  return withWriteMutex(async () => {
    const target = join(deps.vaultDir, ...file.relPath.split("/"));
    const exists = existsSync(target);
    const want = expectedSha256?.trim() ? normalizeSha256(expectedSha256) : "";
    if (!exists) {
      if (want) {
        return {
          ok: false as const,
          error: "FILE_CHANGED" as const,
          currentVersion: "sha256:absent",
          path: file.relPath,
        };
      }
    } else {
      const current = sha256Bytes(await readFile(target));
      if (!want) {
        return { ok: false as const, error: "USAGE" as const, message: "base_sha256 is required to overwrite" };
      }
      if (current !== want) {
        return { ok: false as const, ...fileChangedError(file.relPath, current) };
      }
    }
    await commitUnlocked(deps, [file]);
    return { ok: true as const, paths: [file.relPath] };
  });
}

async function commitUnlocked(deps: TxnDeps, files: TxnFile[]): Promise<{ paths: string[] }> {
  const temps: string[] = [];
  try {
    for (const file of files) {
      const target = join(deps.vaultDir, ...file.relPath.split("/"));
      const tmp = await writeTemp(target, file.content);
      temps.push(tmp);
      try {
        await deps.putObject(file.relPath, Buffer.from(file.content, "utf8"));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw isS3Failure(error) ? error : new S3PutError(message, error);
      }
      await rename(tmp, target);
      temps.pop();
    }
    const paths = files.map((f) => f.relPath);
    deps.onCommit?.(paths);
    return { paths };
  } catch (error: unknown) {
    await Promise.all(
      temps.map(async (tmp) => {
        try {
          await unlink(tmp);
        } catch {
          /* already gone */
        }
      }),
    );
    throw error;
  }
}

export async function commitWrite(deps: TxnDeps, files: TxnFile[]): Promise<{ paths: string[] }> {
  return withWriteMutex(async () => commitUnlocked(deps, files));
}
