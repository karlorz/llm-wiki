import { ok, err, type Result } from "@skillwiki/shared";
import { runFetchGuardSync } from "../commands/fetch-guard.js";

export interface FetchOptions { timeoutMs: number; maxBytes: number; maxRedirects: number }
export interface FetchOk { url: string; status: number; body: string; bytes: number }

export async function controlledFetch(url: string, opts: FetchOptions): Promise<Result<FetchOk>> {
  let current = url;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const guard = runFetchGuardSync({ url: current });
    if (!guard.result.ok) return guard.result;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", signal: ctrl.signal });
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.name === "AbortError") return err("FETCH_TIMEOUT", { url: current });
      return err("FETCH_FAILED", { message: String(e) });
    }
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return err("FETCH_FAILED", { reason: "redirect without Location" });
      current = new URL(loc, current).toString();
      continue;
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) return err("FETCH_TOO_LARGE", { declared, limit: opts.maxBytes });

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > opts.maxBytes) return err("FETCH_TOO_LARGE", { actual: buf.byteLength, limit: opts.maxBytes });
    return ok({ url: current, status: res.status, body: new TextDecoder().decode(buf), bytes: buf.byteLength });
  }
  return err("FETCH_FAILED", { reason: "too many redirects", limit: opts.maxRedirects });
}
