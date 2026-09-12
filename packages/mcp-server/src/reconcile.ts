import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
}): Promise<void> {
  await execFileAsync("rclone", ["copy", "--update", `${opts.remote}:${opts.bucket}`, opts.vaultDir], {
    timeout: 120_000,
  });
}
