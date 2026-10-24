import { WorkspaceError } from "./workspace-store.js";

/** Shared bounded response reader for finite identity/discovery/RPC responses. */
export async function workspaceResponseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new WorkspaceError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

export async function workspaceJson(url: string, init: RequestInit, request: typeof fetch = fetch): Promise<Record<string, any>> {
  const response = await request(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new WorkspaceError("REMOTE_REQUEST_FAILED");
  return JSON.parse((await workspaceResponseBytes(response, 65_536)).toString("utf8"));
}
