import type { ServerResponse } from "node:http";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export class ChangedEventHub {
  private readonly clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pingMs: number;

  constructor(opts: { pingMs?: number } = {}) {
    this.pingMs = opts.pingMs ?? 30_000;
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, SSE_HEADERS);
    res.write(":\n\n");
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
    });
    this.ensurePings();
  }

  emitChanged(paths: string[]): void {
    const payload = `event: changed\ndata: ${JSON.stringify({ paths })}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private ensurePings(): void {
    if (this.pingMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      for (const client of this.clients) {
        client.write(": ping\n\n");
      }
    }, this.pingMs);
    this.timer.unref?.();
  }
}
