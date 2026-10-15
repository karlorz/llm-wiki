import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizeCapture } from "../../src/clip-outbox/localize.js";
import { parseImageDependencies } from "../../src/clip-outbox/images.js";
import { uploadBundle, type CreateOnlyPut } from "../../src/clip-outbox/upload.js";
import type { ResolvedClipOutboxConfig } from "../../src/utils/clip-outbox-config.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function config(root: string): ResolvedClipOutboxConfig {
  return {
    enabled: true,
    root,
    stateRoot: join(root, "state"),
    mirrorRoot: join(root, "wiki"),
    d8NoteRoot: join(root, "notes"),
    d8NoteAbsent: false,
    vaultId: "central",
    allowedPrefixes: ["raw/articles", "raw/assets"],
    destination: "seaweed-wiki:cloud/wiki",
    mode: "event-watch",
    pollFallbackEnabled: true,
    reconcileSeconds: 3600,
    debounceMs: 500,
    stableHashMs: 500,
    maxArticleBytes: 2097152,
    maxImages: 64,
    maxImageBytes: 20971520,
    maxBundleBytes: 104857600,
    maxPixels: 40000000,
    downloadConcurrency: 4,
    imageTypes: ["png", "jpeg", "gif", "webp"],
    maxRedirects: 5,
    requestTimeoutMs: 30000,
    localizeTimeoutMs: 120000,
    readyUrl: "https://wiki.karldigi.dev/file-ingress/ready",
    s3CredentialRef: "CLIP_S3",
    readyCredentialRef: "CLIP_READY",
    watcherLabel: "com.karlchow.skillwiki-clip-outbox",
  };
}

describe("clip-outbox localize and upload", () => {
  it("parses markdown images and ignores ordinary links", () => {
    const refs = parseImageDependencies(
      "![a](https://example.com/a.png) [not](https://example.com/page) ![[raw/assets/x.png]]",
      "https://example.com/post",
    );
    expect(refs.map((r) => r.target)).toEqual([
      "https://example.com/a.png",
      "raw/assets/x.png",
    ]);
  });

  it("localizes https images and freezes embeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "clip-loc-"));
    const result = await localizeCapture(
      "hello ![cat](https://cdn.example/cat.png)",
      { config: config(root), sourceUrl: "https://example.com/p", outboxRoot: root },
      {
        lookup: async () => ["1.1.1.1"],
        fetch: async () => new Response(PNG, { status: 200 }),
      },
    );
    expect(result.markdown).toContain("![[raw/assets/");
    expect(result.markdown).not.toContain("https://cdn.example/cat.png");
    expect(result.assets).toHaveLength(1);
    expect(result.indexMarkdown).toContain("![[raw/assets/");
  });

  it("holds private-IP image URLs and does not upload the article", async () => {
    const root = mkdtempSync(join(tmpdir(), "clip-priv-"));
    await expect(localizeCapture(
      "![x](https://127.0.0.1/secret.png)",
      { config: config(root), outboxRoot: root },
      { lookup: async () => ["127.0.0.1"] },
    )).rejects.toThrow(/blocked/i);

    const puts: string[] = [];
    const put: CreateOnlyPut = async (key) => {
      puts.push(key);
      return { status: "created" };
    };
    expect(puts.filter((k) => k.startsWith("raw/articles/"))).toEqual([]);
  });

  it("treats identical create-only retries as idempotent and different bytes as conflict", async () => {
    const store = new Map<string, Buffer>();
    const put: CreateOnlyPut = async (key, body) => {
      const prev = store.get(key);
      if (!prev) {
        store.set(key, body);
        return { status: "created" };
      }
      return Buffer.compare(prev, body) === 0 ? { status: "idempotent" } : { status: "conflict" };
    };
    const asset = { key: "raw/assets/a/x.png", body: PNG };
    const article = { key: "raw/articles/a.md", body: Buffer.from("hi") };
    const first = await uploadBundle({ put, articleKey: article.key, article: article.body, assets: [asset] });
    const retry = await uploadBundle({ put, articleKey: article.key, article: article.body, assets: [asset] });
    const conflict = await uploadBundle({
      put,
      articleKey: article.key,
      article: Buffer.from("other"),
      assets: [asset],
    });
    expect(first).toEqual({ ok: true });
    expect(retry).toEqual({ ok: true });
    expect(conflict.ok).toBe(false);
  });

  it("snapshots an existing local outbox asset", async () => {
    const root = mkdtempSync(join(tmpdir(), "clip-local-"));
    mkdirSync(join(root, "raw", "assets"), { recursive: true });
    writeFileSync(join(root, "raw", "assets", "shot.png"), PNG);
    const result = await localizeCapture(
      "see ![[raw/assets/shot.png]]",
      { config: config(root), outboxRoot: root },
    );
    expect(result.assets).toHaveLength(1);
    expect(result.markdown).toMatch(/!\[\[raw\/assets\/[a-f0-9]+\/[a-f0-9]{64}\.png\]\]/);
  });
});
