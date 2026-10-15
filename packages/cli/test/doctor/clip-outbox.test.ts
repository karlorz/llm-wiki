import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/commands/doctor.js";

function homeWith(envText: string): string {
  const h = mkdtempSync(join(tmpdir(), "clip-doc-"));
  mkdirSync(join(h, ".skillwiki"), { recursive: true });
  writeFileSync(join(h, ".skillwiki", ".env"), envText);
  return h;
}

describe("doctor clip-outbox probe", () => {
  it("reports not configured when clip is disabled on a fetch-only host", async () => {
    const v = mkdtempSync(join(tmpdir(), "clip-vault-"));
    writeFileSync(join(v, "SCHEMA.md"), "# Schema\n");
    writeFileSync(join(v, ".WIKI_GIT_FROZEN"), "");
    const h = homeWith(`WIKI_PATH=${v}\nvault_sync.installed=true\nvault_sync.role=leaf\nvault_sync.push_enabled=false\n`);
    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.109",
    });
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    const clip = res.result.data.checks.filter((c) => c.id.startsWith("clip_"));
    expect(clip).toHaveLength(8);
    expect(res.result.data.humanHint).toContain("clip-outbox install-or-migrate");
    expect(clip.every((c) => c.status === "info")).toBe(true);
    expect(clip.every((c) => c.detail === "clip channel not configured")).toBe(true);
    expect(JSON.stringify(res.result.data.checks)).not.toContain("SECRET");
  });

  it("fails the watcher row for a retired wiki-dev job", async () => {
    const root = mkdtempSync(join(tmpdir(), "clip-en-"));
    const outbox = join(root, "outbox");
    const state = join(root, "state");
    const mirror = join(root, "wiki");
    const d8 = join(root, "notes");
    mkdirSync(outbox);
    mkdirSync(state);
    mkdirSync(mirror);
    mkdirSync(d8);
    writeFileSync(join(mirror, ".WIKI_GIT_FROZEN"), "");
    writeFileSync(join(mirror, "SCHEMA.md"), "# Schema\n");
    const h = homeWith([
      `WIKI_PATH=${mirror}`,
      "vault_sync.installed=true",
      "vault_sync.role=leaf",
      "vault_sync.push_enabled=false",
      "clip_outbox.enabled=true",
      `clip_outbox.root=${outbox}`,
      `clip_outbox.state_root=${state}`,
      `clip_outbox.mirror_root=${mirror}`,
      `clip_outbox.d8_note_root=${d8}`,
      "clip_outbox.ready_url=https://wiki.karldigi.dev/file-ingress/ready",
      "clip_outbox.s3_credential_ref=CLIP_S3",
      "clip_outbox.ready_credential_ref=CLIP_READY",
    ].join("\n"));
    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.109",
      env: {
        ...process.env,
        CLIP_WATCHER_FIXTURE: "retired-wiki-dev",
        CLIP_PUSH_FIXTURE: "unloaded",
        CLIP_CREDENTIAL_FIXTURE: "present",
        CLIP_CONDITIONAL_CREATE_FIXTURE: "ok",
        CLIP_LISTENER_FIXTURE: "ok",
        CLIP_S3: "1",
        CLIP_READY: "1",
      },
    });
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    const watcher = res.result.data.checks.find((c) => c.id === "clip_watcher");
    expect(watcher?.status).toBe("error");
    expect(watcher?.detail).toMatch(/retired/i);
  });

  it("fails the inbound listener row when the production SSE job is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "clip-listen-"));
    const outbox = join(root, "outbox");
    const state = join(root, "state");
    const mirror = join(root, "wiki");
    const d8 = join(root, "notes");
    mkdirSync(outbox);
    mkdirSync(state);
    mkdirSync(mirror);
    mkdirSync(d8);
    writeFileSync(join(mirror, ".WIKI_GIT_FROZEN"), "");
    writeFileSync(join(mirror, "SCHEMA.md"), "# Schema\n");
    const h = homeWith([
      `WIKI_PATH=${mirror}`,
      "vault_sync.installed=true",
      "vault_sync.role=leaf",
      "vault_sync.push_enabled=false",
      "clip_outbox.enabled=true",
      `clip_outbox.root=${outbox}`,
      `clip_outbox.state_root=${state}`,
      `clip_outbox.mirror_root=${mirror}`,
      `clip_outbox.d8_note_root=${d8}`,
      "clip_outbox.ready_url=https://wiki.karldigi.dev/file-ingress/ready",
      "clip_outbox.s3_credential_ref=CLIP_S3",
      "clip_outbox.ready_credential_ref=CLIP_READY",
    ].join("\n"));
    const res = await runDoctor({
      home: h,
      envValue: undefined,
      argv: ["node", "skillwiki", "doctor"],
      currentVersion: "0.10.111",
      env: {
        ...process.env,
        CLIP_WATCHER_FIXTURE: "loaded-enabled",
        CLIP_PUSH_FIXTURE: "unloaded",
        CLIP_CREDENTIAL_FIXTURE: "present",
        CLIP_CONDITIONAL_CREATE_FIXTURE: "ok",
        CLIP_LISTENER_FIXTURE: "missing",
        CLIP_S3: "1",
        CLIP_READY: "1",
      },
    });
    expect(res.result.ok).toBe(true);
    if (!res.result.ok) return;
    const listener = res.result.data.checks.find((c) => c.id === "clip_mirror_listener");
    expect(listener?.status).toBe("error");
    expect(listener?.detail).toMatch(/SSE listener/i);
  });
});
