import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ChangedEventHub, SSE_HEADERS } from "../src/events.js";

function listen(hub: ChangedEventHub): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/events") hub.subscribe(res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/events`,
        close: () =>
          new Promise((done, fail) => {
            hub.stop();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}

describe("SSE /events", () => {
  it("sets streaming headers and emits changed events", async () => {
    const hub = new ChangedEventHub({ pingMs: 0 });
    const { url, close } = await listen(hub);
    try {
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      expect(res.headers.get("cache-control")).toBe(SSE_HEADERS["Cache-Control"]);
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      hub.emitChanged(["raw/transcripts/a.md"]);
      const reader = res.body!.getReader();
      let text = "";
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !text.includes("event: changed")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("event: changed");
      expect(text).toContain("raw/transcripts/a.md");
      await reader.cancel();
    } finally {
      await close();
    }
  });

  it("writes a comment ping", async () => {
    const hub = new ChangedEventHub({ pingMs: 20 });
    const { url, close } = await listen(hub);
    try {
      const res = await fetch(url);
      const reader = res.body!.getReader();
      const chunks: string[] = [];
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !chunks.join("").includes(": ping")) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
      }
      expect(chunks.join("")).toContain(": ping");
      await reader.cancel();
    } finally {
      await close();
    }
  });

  it("emitChanged after stop writes nothing, ends clients, and clears the set", () => {
    const hub = new ChangedEventHub({ pingMs: 0 });
    const writes: string[] = [];
    let ended = 0;
    const res = {
      writeHead() {},
      write(chunk: string | Buffer) {
        writes.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      },
      end() {
        ended += 1;
      },
      on() {
        return this;
      },
    } as unknown as ServerResponse;

    hub.subscribe(res);
    expect(writes.join("")).toContain(":");
    expect(writes.join("")).not.toContain("event: changed");

    hub.stop();
    expect(ended).toBe(1);
    const afterStop = writes.length;

    hub.emitChanged(["raw/transcripts/after-stop.md"]);
    expect(writes.length).toBe(afterStop);
    expect(writes.join("")).not.toContain("event: changed");
    expect(writes.join("")).not.toContain("after-stop.md");

    hub.stop();
    expect(ended).toBe(1);
  });
});
