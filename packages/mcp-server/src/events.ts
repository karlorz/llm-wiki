import type { ServerResponse } from "node:http";
import { DEFAULT_VAULT_ID } from "./vault-id.js";

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

type EventClient = { res: ServerResponse; allowedVaults?: readonly string[]; authorized?: () => boolean };

export class ChangedEventHub {
  private readonly clients = new Set<EventClient>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pingMs: number;

  constructor(opts: { pingMs?: number } = {}) {
    this.pingMs = opts.pingMs ?? 30_000;
  }

  subscribe(res: ServerResponse, filter?: { allowedVaults?: readonly string[]; authorized?: () => boolean }): void {
    res.writeHead(200, SSE_HEADERS);
    res.write(":\n\n");
    const client: EventClient = { res, allowedVaults: filter?.allowedVaults, authorized: filter?.authorized };
    this.clients.add(client);
    res.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopTimer();
    });
    this.ensurePings();
  }

  emitChanged(paths: string[], vaultId = DEFAULT_VAULT_ID): void {
    const payload = `event: changed\ndata: ${JSON.stringify({ vault_id: vaultId, paths })}\n\n`;
    for (const client of this.clients) {
      if (!this.authorized(client)) continue;
      if (client.allowedVaults && !client.allowedVaults.includes(vaultId)) continue;
      client.res.write(payload);
    }
  }

  stop(): void {
    this.stopTimer();
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private authorized(client: EventClient): boolean {
    try { if (!client.authorized || client.authorized()) return true; } catch { /* fail closed */ }
    this.clients.delete(client); client.res.end();
    if (this.clients.size === 0) this.stopTimer();
    return false;
  }

  private ensurePings(): void {
    if (this.pingMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      for (const client of this.clients) {
        if (!this.authorized(client)) continue;
        client.res.write(": ping\n\n");
      }
    }, this.pingMs);
    this.timer.unref?.();
  }
}
