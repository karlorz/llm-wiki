import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClipOutboxConfig } from "../../src/utils/clip-outbox-config.js";

export async function clipFixture() {
  const home = await mkdtemp(join(tmpdir(), "clip-worker-"));
  const root = join(home, "Obsidian/clip-outbox");
  const stateRoot = join(home, "state");
  const mirrorRoot = join(home, "wiki");
  await Promise.all([mkdir(join(root, "raw/articles"), { recursive: true }), mkdir(join(root, "raw/assets"), { recursive: true }), mkdir(stateRoot), mkdir(mirrorRoot), mkdir(join(home, ".skillwiki"))]);
  await writeFile(join(mirrorRoot, ".WIKI_GIT_FROZEN"), "");
  const map = {
    "clip_outbox.enabled": "true", "clip_outbox.root": root,
    "clip_outbox.state_root": stateRoot, "clip_outbox.mirror_root": mirrorRoot,
    "clip_outbox.d8_note_absent": "true", "clip_outbox.s3_credential_ref": "CLIP_S3",
    "clip_outbox.ready_credential_ref": "CLIP_READY", "clip_outbox.ready_url": "https://example.com/file-ingress/ready",
    "clip_outbox.poll_fallback_enabled": "false", "vault_sync.push_enabled": "false",
  };
  await writeFile(join(home, ".skillwiki/.env"), Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n"));
  const resolved = resolveClipOutboxConfig(map, home);
  if (!resolved.ok || !resolved.enabled) throw new Error("invalid fixture");
  return { home, config: { ...resolved.config, debounceMs: 20, stableHashMs: 20 }, map };
}
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export async function until(predicate: () => boolean | Promise<boolean>, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
