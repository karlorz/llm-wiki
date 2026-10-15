import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import {
  extensionForKind,
  localAssetRelPath,
  parseImageDependencies,
  pngPixelCount,
  sniffImageKind,
  type ImageKind,
} from "./images.js";
import { assertPublicHttpsUrl, type LookupFn } from "./ssrf.js";
import { sha256Hex } from "./upload.js";

export interface LocalizedAsset {
  captureRel: string;
  sha256: string;
  bytes: Buffer;
  kind: ImageKind;
  source: string;
}

export interface LocalizeResult {
  captureId: string;
  markdown: string;
  assets: LocalizedAsset[];
  indexMarkdown: string;
}

export interface LocalizeDeps {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  readLocal?: (absPath: string) => Promise<Buffer>;
  now?: () => number;
}

class LocalizeError extends Error {
  constructor(message: string, readonly code = "LOCALIZE_HELD") {
    super(message);
    this.name = "LocalizeError";
  }
}

function isInsideDir(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function localizeCapture(
  markdown: string,
  opts: {
    config: ResolvedClipOutboxConfig;
    sourceUrl?: string;
    outboxRoot: string;
    captureId?: string;
  },
  deps: LocalizeDeps = {},
): Promise<LocalizeResult> {
  const captureId = opts.captureId ?? randomUUID().replace(/-/g, "").slice(0, 16);
  const refs = parseImageDependencies(markdown, opts.sourceUrl);
  if (refs.length > opts.config.maxImages) {
    throw new LocalizeError(`too many images: ${refs.length}`);
  }
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const assets: LocalizedAsset[] = [];
  const seenUrl = new Map<string, LocalizedAsset>();
  const replacements = new Map<string, string>();
  const deadline = now() + opts.config.localizeTimeoutMs;
  let bundleBytes = Buffer.byteLength(markdown);

  for (const ref of refs) {
    if (now() > deadline) throw new LocalizeError("localize deadline exceeded");
    let asset = seenUrl.get(ref.target);
    if (!asset) {
      if (ref.local) {
        const rel = localAssetRelPath(ref.target);
        if (!rel) throw new LocalizeError(`unsafe or missing local image: ${ref.target}`);
        const abs = resolve(opts.outboxRoot, rel);
        if (!isInsideDir(resolve(opts.outboxRoot, "raw/assets"), abs)) {
          throw new LocalizeError("local image outside raw/assets");
        }
        const reader = deps.readLocal ?? ((p: string) => readFile(p));
        const bytes = await reader(abs);
        asset = sealAsset(captureId, bytes, ref.target, opts.config);
        // Existing referenced binaries retain their exact paths.
        asset.captureRel = rel;
      } else {
        const bytes = await downloadImage(ref.target, opts.config, fetchImpl, deps.lookup);
        asset = sealAsset(captureId, bytes, ref.target, opts.config);
      }
      bundleBytes += asset.bytes.length;
      if (bundleBytes > opts.config.maxBundleBytes) throw new LocalizeError("bundle too large");
      assets.push(asset);
      seenUrl.set(ref.target, asset);
    }
    replacements.set(ref.raw, `![[${asset.captureRel}]]`);
  }

  let rewritten = markdown;
  for (const [raw, embed] of replacements) {
    rewritten = rewritten.replaceAll(raw, embed);
  }

  const indexMarkdown = [
    "---",
    `title: clip assets ${captureId}`,
    "---",
    "",
    ...assets.map((a) => `- ![[${a.captureRel}]]`),
    "",
  ].join("\n");
  bundleBytes += Buffer.byteLength(indexMarkdown);
  if (bundleBytes > opts.config.maxBundleBytes) throw new LocalizeError("bundle too large");

  return { captureId, markdown: rewritten, assets, indexMarkdown };
}

function sealAsset(
  captureId: string,
  bytes: Buffer,
  source: string,
  config: ResolvedClipOutboxConfig,
): LocalizedAsset {
  if (bytes.length > config.maxImageBytes) throw new LocalizeError("image too large");
  const kind = sniffImageKind(bytes);
  if (!kind || !config.imageTypes.includes(kind)) throw new LocalizeError("unsupported image type");
  const pixels = pngPixelCount(bytes);
  if (pixels !== undefined && pixels > config.maxPixels) throw new LocalizeError("image pixel budget exceeded");
  const sha256 = sha256Hex(bytes);
  return {
    captureRel: `raw/assets/${captureId}/${sha256}.${extensionForKind(kind)}`,
    sha256,
    bytes,
    kind,
    source,
  };
}

async function downloadImage(
  href: string,
  config: ResolvedClipOutboxConfig,
  fetchImpl: typeof fetch,
  lookup?: LookupFn,
): Promise<Buffer> {
  let current = href;
  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    const guarded = await assertPublicHttpsUrl(current, lookup);
    if (!guarded.ok) {
      throw new LocalizeError(
        hop === 0 ? `blocked image URL: ${guarded.reason}` : `redirect blocked: ${guarded.reason}`,
      );
    }
    const res = await fetchImpl(current, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new LocalizeError("redirect without location");
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok || !res.body) throw new LocalizeError(`image HTTP ${res.status}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > config.maxImageBytes) throw new LocalizeError("image too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new LocalizeError("too many redirects");
}
