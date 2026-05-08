import { describe, it, expect, afterEach, vi } from "vitest";
import { controlledFetch } from "../../src/utils/fetch.js";

const realFetch = globalThis.fetch;

describe("controlledFetch — Layer 2", () => {
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it("aborts when timeout exceeded", { timeout: 10000 }, async () => {
    globalThis.fetch = vi.fn((_url: string, opts: any) => new Promise((_resolve, reject) => {
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }
    })) as any;
    const r = await controlledFetch("https://example.com/slow", { timeoutMs: 25, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("FETCH_TIMEOUT");
  });

  it("rejects when body exceeds maxBytes", async () => {
    const big = "x".repeat(2048);
    globalThis.fetch = vi.fn(async () => new Response(big, { status: 200, headers: { "content-length": "2048" } })) as any;
    const r = await controlledFetch("https://example.com/big", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("FETCH_TOO_LARGE");
  });

  it("re-validates redirect targets via fetch-guard", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: any) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://10.0.0.1/secret" } });
      return new Response("ok", { status: 200 });
    }) as any;
    const r = await controlledFetch("https://example.com/redir", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("HOST_BLOCKED");
  });

  it("returns body on success", async () => {
    globalThis.fetch = vi.fn(async () => new Response("hello", { status: 200 })) as any;
    const r = await controlledFetch("https://example.com/x", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.body).toBe("hello");
  });

  it("returns FETCH_FAILED on non-abort network error", async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError("fetch failed"); }) as any;
    const r = await controlledFetch("https://example.com/down", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("FETCH_FAILED");
  });

  it("returns FETCH_FAILED when redirect has no Location header", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 301, headers: {} })) as any;
    const r = await controlledFetch("https://example.com/badredir", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("FETCH_FAILED");
      expect(r.detail).toMatchObject({ reason: "redirect without Location" });
    }
  });

  it("returns FETCH_FAILED when redirect count exceeds maxRedirects", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://example.com/loop" } });
    }) as any;
    const r = await controlledFetch("https://example.com/redir", { timeoutMs: 1000, maxBytes: 1024, maxRedirects: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("FETCH_FAILED");
      expect(r.detail).toMatchObject({ reason: "too many redirects" });
    }
  });
});
