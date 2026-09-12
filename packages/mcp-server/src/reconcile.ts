import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Inbound `rclone copy --update` must outlast a ~20k-object vault; 120s is too tight. */
export const DEFAULT_RCLONE_COPY_TIMEOUT_MS = 600_000;

export type RcloneExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class ToolsNotReadyError extends Error {
  readonly code = "TOOLS_NOT_READY";
  constructor() {
    super("tools blocked until first S3 reconcile completes");
    this.name = "ToolsNotReadyError";
  }
}

export class ReconcileGate {
  ready = false;
  private first: Promise<void> | undefined;

  constructor(private readonly copyInbound: () => Promise<void>) {}

  assertReady(): void {
    if (!this.ready) throw new ToolsNotReadyError();
  }

  async runFirst(): Promise<void> {
    if (!this.first) {
      this.first = this.copyInbound().then(() => {
        this.ready = true;
      });
    }
    await this.first;
  }

  async runPeriodic(): Promise<void> {
    await this.copyInbound();
    this.ready = true;
  }
}

export async function rcloneCopyUpdate(opts: {
  remote: string;
  bucket: string;
  vaultDir: string;
  timeoutMs?: number;
  execFile?: RcloneExecFile;
}): Promise<void> {
  const timeout = opts.timeoutMs ?? DEFAULT_RCLONE_COPY_TIMEOUT_MS;
  const run = opts.execFile ?? execFileAsync;
  await run("rclone", ["copy", "--update", `${opts.remote}:${opts.bucket}`, opts.vaultDir], {
    timeout,
  });
}
