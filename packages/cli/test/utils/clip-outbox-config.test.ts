import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClipOutboxConfig } from "../../src/utils/clip-outbox-config.js";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "clip-cfg-"));
  const outbox = join(root, "outbox");
  const state = join(root, "state");
  const mirror = join(root, "wiki");
  const d8 = join(root, "notes");
  mkdirSync(outbox);
  mkdirSync(state);
  mkdirSync(mirror);
  mkdirSync(d8);
  writeFileSync(join(mirror, ".WIKI_GIT_FROZEN"), "");
  return { root, outbox, state, mirror, d8 };
}

function enabledMap(paths: ReturnType<typeof dirs>): Record<string, string> {
  return {
    "clip_outbox.enabled": "true",
    "clip_outbox.root": paths.outbox,
    "clip_outbox.state_root": paths.state,
    "clip_outbox.mirror_root": paths.mirror,
    "clip_outbox.d8_note_root": paths.d8,
    "clip_outbox.ready_url": "https://wiki.karldigi.dev/file-ingress/ready",
    "clip_outbox.s3_credential_ref": "CLIP_S3",
    "clip_outbox.ready_credential_ref": "CLIP_READY",
  };
}

describe("resolveClipOutboxConfig", () => {
  it("treats missing enabled as disabled", () => {
    const r = resolveClipOutboxConfig({}, "/tmp");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enabled).toBe(false);
  });

  it("accepts a disjoint dedicated outbox", () => {
    const paths = dirs();
    const r = resolveClipOutboxConfig(enabledMap(paths), paths.root);
    expect(r.ok).toBe(true);
    if (r.ok && r.enabled) {
      expect(r.config.root).toBe(realpathSync(paths.outbox));
      expect(r.config.mode).toBe("event-watch");
    }
  });

  it("rejects an outbox nested in the frozen mirror", () => {
    const paths = dirs();
    const nested = join(paths.mirror, "raw", "articles");
    mkdirSync(nested, { recursive: true });
    const map = enabledMap(paths);
    map["clip_outbox.root"] = nested;
    const r = resolveClipOutboxConfig(map, paths.root);
    expect(r.ok).toBe(false);
  });

  it("rejects mixing D8 note outbox with clip outbox", () => {
    const paths = dirs();
    const map = enabledMap(paths);
    map["clip_outbox.root"] = paths.d8;
    const r = resolveClipOutboxConfig(map, paths.root);
    expect(r.ok).toBe(false);
  });
});
