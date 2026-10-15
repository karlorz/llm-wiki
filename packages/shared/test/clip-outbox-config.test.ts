import { describe, expect, it } from "vitest";
import {
  CLIP_OUTBOX_KEYS,
  isClipOutboxKey,
  parseClipOutboxKeyValue,
} from "../src/schemas.js";

describe("clip_outbox config schema", () => {
  it("rejects unknown keys", () => {
    expect(isClipOutboxKey("clip_outbox.bogus")).toBe(false);
    expect(parseClipOutboxKeyValue("clip_outbox.bogus", "x").ok).toBe(false);
  });

  it("accepts production defaults", () => {
    expect(parseClipOutboxKeyValue("clip_outbox.enabled", "false").ok).toBe(true);
    expect(parseClipOutboxKeyValue("clip_outbox.vault_id", "central").ok).toBe(true);
    expect(parseClipOutboxKeyValue("clip_outbox.mode", "event-watch").ok).toBe(true);
    expect(parseClipOutboxKeyValue("clip_outbox.destination", "seaweed-wiki:cloud/wiki").ok).toBe(true);
    expect(parseClipOutboxKeyValue("clip_outbox.watcher_label", "com.karlchow.skillwiki-clip-outbox").ok).toBe(true);
  });

  it("rejects poll-only mode and watching the mirror destination string", () => {
    expect(parseClipOutboxKeyValue("clip_outbox.mode", "poll-only").ok).toBe(false);
    expect(parseClipOutboxKeyValue("clip_outbox.vault_id", "wiki-dev").ok).toBe(false);
    expect(parseClipOutboxKeyValue("clip_outbox.ready_url", "http://example.com/file-ingress/ready").ok).toBe(false);
    expect(parseClipOutboxKeyValue("clip_outbox.ready_url", "https://user:pass@example.com/ready").ok).toBe(false);
  });

  it("caps numeric budgets", () => {
    expect(parseClipOutboxKeyValue("clip_outbox.max_images", "64").ok).toBe(true);
    expect(parseClipOutboxKeyValue("clip_outbox.max_images", "65").ok).toBe(false);
    expect(parseClipOutboxKeyValue("clip_outbox.debounce_ms", "50").ok).toBe(false);
    expect(CLIP_OUTBOX_KEYS.length).toBeGreaterThan(10);
  });
});
