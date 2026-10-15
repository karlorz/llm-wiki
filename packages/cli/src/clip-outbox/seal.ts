import { randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import yaml from "js-yaml";
import type { ResolvedClipOutboxConfig } from "../utils/clip-outbox-config.js";
import { localizeCapture, type LocalizeDeps } from "./localize.js";
import { readRegular } from "./files.js";
import { sha256Hex } from "./upload.js";
import type { JournalEntry } from "./journal.js";

export class UnstableCapture extends Error {}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export function snapshotPath(config: ResolvedClipOutboxConfig, entry: JournalEntry, key: string): string {
  if (!/^(raw\/articles\/|raw\/assets\/)[A-Za-z0-9._/-]+$/.test(key) || key.split("/").some((p) => !p || p === "." || p === "..")) throw new Error("unsafe snapshot key");
  return join(config.stateRoot, entry.captureId, entry.snapshotId ?? "legacy", "files", key);
}
async function durableFile(root: string, path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const f = await open(path, "wx", 0o600);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  // The sealed journal must never outlive the directory entries it references.
  let dir = dirname(path);
  while (true) {
    const handle = await open(dir, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("snapshot directory outside state root");
    dir = parent;
  }
}
export async function sealCapture(config: ResolvedClipOutboxConfig, entry: JournalEntry, deps: LocalizeDeps & { delay?: (ms: number) => Promise<void> } = {}): Promise<JournalEntry> {
  entry = { ...entry, snapshotId: randomBytes(8).toString("hex") };
  const source = entry.source!;
  const inputs = new Map<string, Buffer>();
  const article = await readRegular(config.root, source, config.maxArticleBytes);
  inputs.set(source, article);
  // Check article and every referenced local dependency twice; remote bytes become
  // immutable snapshots once downloaded, rather than being fetched again to seal.
  let sourceUrl: string | undefined;
  const fm = article.toString("utf8").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (fm) {
    const metadata = yaml.load(fm[1]) as Record<string, unknown> | undefined;
    const url = metadata?.source_url ?? metadata?.source;
    if (typeof url === "string") sourceUrl = url;
  }
  const localized = await localizeCapture(article.toString("utf8"), { config, sourceUrl, outboxRoot: config.root, captureId: entry.captureId }, {
    ...deps,
    readLocal: async (path) => {
      const bytes = await readRegular(config.root, path, config.maxImageBytes);
      inputs.set(path, bytes);
      return bytes;
    },
  });
  await (deps.delay ?? sleep)(config.stableHashMs);
  for (const [path, bytes] of inputs) {
    const next = await readRegular(config.root, path, path === source ? config.maxArticleBytes : config.maxImageBytes);
    if (sha256Hex(bytes) !== sha256Hex(next)) throw new UnstableCapture("capture changed before seal");
  }
  const finalArticle = Buffer.from(localized.markdown);
  if (finalArticle.length > config.maxArticleBytes) throw new Error("localized article too large");
  const objects = new Map(localized.assets.map((a) => [a.captureRel, a.bytes]));
  objects.set(`raw/assets/${entry.captureId}/note.md`, Buffer.from(localized.indexMarkdown));
  objects.set(entry.articleKey, finalArticle);
  if ([...objects.values()].reduce((n, b) => n + b.length, 0) > config.maxBundleBytes) throw new Error("sealed bundle too large");
  // A fresh staging directory per preparation prevents a crash from mixing generations.
  // Unreferenced preparation directories are retained for attended recovery.
  await durableFile(config.stateRoot, join(config.stateRoot, entry.captureId, entry.snapshotId!, "original.md"), article);
  for (const [key, bytes] of objects) await durableFile(config.stateRoot, snapshotPath(config, entry, key), bytes);
  return { ...entry, sourceSha256: sha256Hex(article), assetKeys: [...objects.keys()].filter((k) => k !== entry.articleKey), sha256: Object.fromEntries([...objects].map(([k, b]) => [k, sha256Hex(b)])), sizes: Object.fromEntries([...objects].map(([k, b]) => [k, b.length])), receipts: {}, state: "sealed", reason: undefined, attempts: 0, retryAt: undefined, updatedAt: new Date().toISOString() };
}
export function admittedArticle(root: string, path: string): boolean {
  const rel = relative(root, path).replaceAll("\\", "/");
  if (!rel.startsWith("raw/articles/") || !rel.endsWith(".md")) return false;
  return rel.split("/").every((part) => part !== "." && part !== ".." && !part.startsWith(".") && !/[\x00-\x1f]/.test(part) && !part.endsWith("~"));
}
