import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
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

export async function commitWrite(deps: TxnDeps, files: TxnFile[]): Promise<{ paths: string[] }> {
  return withWriteMutex(async () => {
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
  });
}
