import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { writeRegularExclusive } from "./files.js";
import { parseDestination } from "./upload.js";

const ADMIT = /^raw\/(articles|assets)\/[A-Za-z0-9._/-]+$/;

export function admitMirrorPath(path: string): boolean {
  return ADMIT.test(path) && !path.split("/").some((part) => part === ".." || part === "." || !part);
}

export function orderMirrorPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.filter(admitMirrorPath))];
  return [...unique.filter((path) => path.startsWith("raw/assets/")), ...unique.filter((path) => path.startsWith("raw/articles/"))];
}

export function eventsUrlFromMcp(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "/events";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function wikiFetchPullLockDir(home: string): string {
  return join(home, "Library", "Caches", "vault-sync", "wiki-fetch", "pull.lock.d");
}

export async function acquireWikiFetchPullLock(home: string): Promise<(() => Promise<void>) | null> {
  const lockDir = wikiFetchPullLockDir(home);
  await mkdir(dirname(lockDir), { recursive: true });
  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  return async () => { await rmdir(lockDir).catch(() => undefined); };
}

export function parseChangedSseBlock(block: string): { vault_id: string; paths: string[] } | null {
  let event = "message";
  let data = "";
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trimStart();
  }
  if (event !== "changed" || !data) return null;
  try {
    const parsed = JSON.parse(data) as { vault_id?: unknown; paths?: unknown };
    if (parsed.vault_id !== "central" || !Array.isArray(parsed.paths)) return null;
    return { vault_id: "central", paths: parsed.paths.filter((path): path is string => typeof path === "string") };
  } catch {
    return null;
  }
}

export async function applyMirrorPaths(opts: {
  paths: readonly string[];
  getObject: (key: string) => Promise<Buffer | null>;
  write: (rel: string, body: Buffer) => Promise<"created" | "idempotent" | "conflict">;
  lock: () => Promise<(() => Promise<void>) | null>;
}): Promise<{ copied: string[]; skipped: string[] }> {
  const ordered = orderMirrorPaths(opts.paths);
  const release = await opts.lock();
  if (!release) return { copied: [], skipped: ordered };
  try {
    const copied: string[] = [];
    const skipped: string[] = [];
    for (const rel of ordered) {
      const body = await opts.getObject(rel);
      if (!body) { skipped.push(rel); continue; }
      const result = await opts.write(rel, body);
      if (result === "conflict") skipped.push(rel);
      else copied.push(rel);
    }
    return { copied, skipped };
  } finally {
    await release();
  }
}

export function createS3GetObject(opts: { client: S3Client; bucket: string; prefix?: string; maxBytes: number }) {
  const prefix = opts.prefix ?? "";
  const resolveKey = (rel: string) => [prefix, rel].filter(Boolean).join("/");
  return async (key: string): Promise<Buffer | null> => {
    if (!admitMirrorPath(key)) return null;
    try {
      const response = await opts.client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: resolveKey(key) }));
      if (!response.Body) return null;
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      return bytes.length > opts.maxBytes ? null : bytes;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === "NoSuchKey") return null;
      throw error;
    }
  };
}

export async function startMirrorListener(input: {
  home: string;
  config: ResolvedClipOutboxConfig;
  eventsUrl: string;
  mcpToken: string;
  getObject: (key: string) => Promise<Buffer | null>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  lock?: () => Promise<(() => Promise<void>) | null>;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const write = (rel: string, body: Buffer) => writeRegularExclusive(input.config.mirrorRoot, rel, body);
  const lock = input.lock ?? (() => acquireWikiFetchPullLock(input.home));
  let delayMs = 1000;
  while (!input.signal.aborted) {
    try {
      const response = await fetchImpl(input.eventsUrl, {
        headers: { Authorization: `Bearer ${input.mcpToken}`, Accept: "text/event-stream" },
        signal: input.signal,
      });
      if (!response.ok || !response.body) throw new Error("sse unavailable");
      delayMs = 1000;
      let buffer = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!input.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let split: number;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const changed = parseChangedSseBlock(block);
          if (!changed) continue;
          await applyMirrorPaths({ paths: changed.paths, getObject: input.getObject, write, lock });
        }
      }
    } catch (error) {
      if (input.signal.aborted) return;
      if ((error as { name?: string }).name === "AbortError") return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

export function parseDestinationForMirror(destination: string) {
  return parseDestination(destination);
}
