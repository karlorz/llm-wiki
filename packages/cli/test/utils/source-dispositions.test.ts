import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySourceDisposition, bodySha256, planSourceDisposition, readSourceDispositions } from "../../src/utils/source-dispositions.js";
import { inventorySources } from "../../src/utils/source-lifecycle.js";
import { writeLogEvent } from "../../src/utils/log-events.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "sw-disposition-"));
  dirs.push(root);
  writeFileSync(join(root, "SCHEMA.md"), "# schema\n");
  mkdirSync(join(root, "raw", "articles"), { recursive: true });
  writeFileSync(join(root, "raw", "articles", "source.md"), "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nBody\n");
  return root;
}

describe("source dispositions", () => {
  it("writes an append-only deferred decision without changing raw bytes", async () => {
    const root = vault();
    const rawPath = "raw/articles/source.md";
    const before = readFileSync(join(root, rawPath), "utf8");
    const plan = await planSourceDisposition({ vault: root, rawPath, status: "deferred", reason: "Wait for release", reviewAfter: "2026-08-15", today: "2026-08-02", now: "2026-08-02T00:00:00.000Z" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const applied = await applySourceDisposition({ vault: root, rawPath, status: "deferred", reason: "Wait for release", reviewAfter: "2026-08-15", today: "2026-08-02", approve: plan.data.approval_token });
    expect(applied.ok).toBe(true);
    expect(readFileSync(join(root, rawPath), "utf8")).toBe(before);
    const events = await readSourceDispositions(root);
    expect(events.ok && events.data[0]).toMatchObject({ raw_path: rawPath, status: "deferred", review_after: "2026-08-15" });
    const inventory = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(inventory.output?.items[0]?.lifecycle_status).toBe("deferred");
  });

  it("resurfaces changed evidence when disposition body identity no longer matches", async () => {
    const root = vault();
    const rawPath = "raw/articles/source.md";
    const plan = await planSourceDisposition({ vault: root, rawPath, status: "reviewed-no-op", reason: "No maintained change", now: "2026-08-02T00:00:00.000Z" });
    if (!plan.ok) throw new Error("plan failed");
    await applySourceDisposition({ vault: root, rawPath, status: "reviewed-no-op", reason: "No maintained change", approve: plan.data.approval_token });
    writeFileSync(join(root, rawPath), "---\ntitle: Source\nsource_url: https://example.com\ningested: 2026-08-02\n---\nChanged body\n");
    const inventory = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(inventory.output?.items[0]).toMatchObject({ lifecycle_status: "pending", disposition_identity_mismatch: true });
  });

  it("resurfaces same-body evidence when complete frontmatter identity changes", async () => {
    const root = vault();
    const rawPath = "raw/articles/source.md";
    const plan = await planSourceDisposition({ vault: root, rawPath, status: "reviewed-no-op", reason: "No maintained change", now: "2026-08-02T00:00:00.000Z" });
    if (!plan.ok) throw new Error("plan failed");
    await applySourceDisposition({ vault: root, rawPath, status: "reviewed-no-op", reason: "No maintained change", approve: plan.data.approval_token });
    writeFileSync(join(root, rawPath), "---\ntitle: Source\nsource_url: https://changed.example.com\ningested: 2026-08-02\n---\nBody\n");
    const inventory = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(inventory.output?.items[0]).toMatchObject({ lifecycle_status: "pending", disposition_identity_mismatch: true });
  });

  it("keeps legacy body-hash disposition events read-compatible", async () => {
    const root = vault();
    const rawPath = "raw/articles/source.md";
    const text = readFileSync(join(root, rawPath), "utf8");
    const event = await writeLogEvent(root, {
      schema: "skillwiki-log-event/v1",
      operation_id: "1".repeat(64),
      occurred_at: "2026-08-01T00:00:00.000Z",
      host_id: "test",
      actor: "test",
      kind: "source-disposition",
      target: rawPath,
      note: "legacy compatibility",
      metadata: {
        status: "reviewed-no-op",
        raw_path: rawPath,
        body_sha256: bodySha256(text),
        reason: "legacy compatibility",
      },
    });
    expect(event.ok).toBe(true);
    const inventory = await inventorySources({ vault: root, today: "2026-08-02" });
    expect(inventory.output?.items[0]?.lifecycle_status).toBe("reviewed-no-op");
  });

  it("validates deferred and duplicate status-specific fields", async () => {
    const root = vault();
    expect((await planSourceDisposition({ vault: root, rawPath: "raw/articles/source.md", status: "deferred", reason: "later", reviewAfter: "2026-08-01", today: "2026-08-02" })).ok).toBe(false);
    expect((await planSourceDisposition({ vault: root, rawPath: "raw/articles/source.md", status: "duplicate", reason: "same", duplicateOf: "raw/articles/source.md" })).ok).toBe(false);
  });

  it("rejects transitive duplicate cycles", async () => {
    const root = vault();
    writeFileSync(join(root, "raw", "articles", "second.md"), "---\ntitle: Second\nsource_url: https://example.com/2\ningested: 2026-08-02\n---\nBody 2\n");
    const first = await planSourceDisposition({
      vault: root,
      rawPath: "raw/articles/source.md",
      status: "duplicate",
      reason: "Same as second",
      duplicateOf: "raw/articles/second.md",
      now: "2026-08-02T00:00:00.000Z",
    });
    if (!first.ok) throw new Error("first duplicate plan failed");
    await applySourceDisposition({
      vault: root,
      rawPath: "raw/articles/source.md",
      status: "duplicate",
      reason: "Same as second",
      duplicateOf: "raw/articles/second.md",
      approve: first.data.approval_token,
    });

    const cycle = await planSourceDisposition({
      vault: root,
      rawPath: "raw/articles/second.md",
      status: "duplicate",
      reason: "Would create a cycle",
      duplicateOf: "raw/articles/source.md",
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error).toBe("SOURCE_DISPOSITION_INVALID");
  });
});
