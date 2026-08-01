import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { scanVault } from "./vault.js";

export type RawAssetReferenceKind = "obsidian-embed" | "markdown-image" | "external-image" | "ambiguous-embed";

export interface RawAssetReference {
  source_path: string;
  target: string;
  kind: RawAssetReferenceKind;
  exists: boolean;
  preview_supported: boolean;
  candidates?: string[];
}

export interface RawAssetReferenceIndex {
  assets: string[];
  inbound: Map<string, string[]>;
  references: RawAssetReference[];
}

const PREVIEW_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "pdf", "mp3", "wav", "m4a", "mp4", "webm"]);

async function walkFiles(root: string, dir = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(root, path));
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

function supportedPreview(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return PREVIEW_EXTENSIONS.has(ext);
}

function addInbound(map: Map<string, Set<string>>, target: string, source: string): void {
  const refs = map.get(target) ?? new Set<string>();
  refs.add(source);
  map.set(target, refs);
}

export async function buildRawAssetReferenceIndex(vault: string): Promise<RawAssetReferenceIndex> {
  const assetRoot = join(vault, "raw", "assets");
  const relativeAssets = await walkFiles(assetRoot);
  const assets = relativeAssets.map((path) => `raw/assets/${path}`).sort((a, b) => a.localeCompare(b));
  const assetSet = new Set(assets);
  const byBasename = new Map<string, string[]>();
  for (const asset of assets) {
    const name = asset.slice(asset.lastIndexOf("/") + 1);
    byBasename.set(name, [...(byBasename.get(name) ?? []), asset]);
  }

  const scan = await scanVault(vault);
  if (!scan.ok) return { assets, inbound: new Map(), references: [] };
  const inboundSets = new Map<string, Set<string>>();
  const references: RawAssetReference[] = [];

  for (const page of scan.data.allMarkdown) {
    let text: string;
    try {
      text = await readFile(page.absPath, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = match[1]!.trim();
      if (target.startsWith("raw/assets/")) {
        const exists = assetSet.has(target);
        references.push({ source_path: page.relPath, target, kind: "obsidian-embed", exists, preview_supported: supportedPreview(target) });
        if (exists) addInbound(inboundSets, target, page.relPath);
      } else if (!target.includes("/")) {
        const candidates = (byBasename.get(target) ?? []).sort((a, b) => a.localeCompare(b));
        if (candidates.length > 0) {
          references.push({ source_path: page.relPath, target, kind: "ambiguous-embed", exists: candidates.length === 1, preview_supported: supportedPreview(target), candidates });
          if (candidates.length === 1) addInbound(inboundSets, candidates[0]!, page.relPath);
        }
      }
    }
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]!.trim().replace(/^<|>$/g, "");
      if (/^https?:\/\//i.test(target)) {
        references.push({ source_path: page.relPath, target, kind: "external-image", exists: true, preview_supported: supportedPreview(new URL(target).pathname) });
      } else if (target.startsWith("raw/assets/")) {
        const exists = assetSet.has(target);
        references.push({ source_path: page.relPath, target, kind: "markdown-image", exists, preview_supported: supportedPreview(target) });
        if (exists) addInbound(inboundSets, target, page.relPath);
      }
    }
  }

  references.sort((a, b) => a.target.localeCompare(b.target) || a.source_path.localeCompare(b.source_path));
  const inbound = new Map([...inboundSets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([target, refs]) => [target, [...refs].sort()]));
  return { assets, inbound, references };
}
