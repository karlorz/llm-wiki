import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHash } from "../../src/commands/hash.js";

function tmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-hash-"));
  const p = join(dir, "f.md");
  writeFileSync(p, content);
  return p;
}

describe("hash", () => {
  it("hashes body bytes after closing ---", async () => {
    const p = tmp("---\ntitle: x\n---\nhello");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    expect(r.result.ok).toBe(true);
    if (r.result.ok) {
      // sha256("hello")
      expect(r.result.data.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      expect(r.result.data.byte_count).toBe(5);
    }
  });

  it("returns FILE_NOT_FOUND for missing file", async () => {
    const r = await runHash({ file: "/no/such/file" });
    expect(r.exitCode).toBe(2);
  });

  it("returns MISSING_CLOSING_DELIMITER when --- never closes", async () => {
    const p = tmp("---\ntitle: x\nno close");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(3);
  });

  it("hashes whole file when no frontmatter present", async () => {
    const p = tmp("plain body");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) expect(r.result.data.byte_count).toBe(10);
  });

  it("does NOT normalize (CRLF preserved)", async () => {
    const p1 = tmp("---\nx: 1\n---\nhello\nworld");
    const p2 = tmp("---\nx: 1\n---\nhello\r\nworld");
    const r1 = await runHash({ file: p1 });
    const r2 = await runHash({ file: p2 });
    if (r1.result.ok && r2.result.ok) expect(r1.result.data.sha256).not.toBe(r2.result.data.sha256);
  });

  it("hashes a file with CRLF line endings", async () => {
    const p = tmp("---\r\ntitle: x\r\n---\r\nhello");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      // CRLF frontmatter delimiters are handled; body "hello" extracts cleanly
      expect(r.result.data.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
      expect(r.result.data.byte_count).toBe(5);
    }
  });

  it("hashes an empty body", async () => {
    const p = tmp("---\ntitle: x\n---\n");
    const r = await runHash({ file: p });
    expect(r.exitCode).toBe(0);
    if (r.result.ok) {
      expect(r.result.data.byte_count).toBe(0);
      expect(r.result.data.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
  });

  it("differs from hash of body with trailing newline", async () => {
    const p1 = tmp("---\ntitle: x\n---\nhello");
    const p2 = tmp("---\ntitle: x\n---\nhello\n");
    const r1 = await runHash({ file: p1 });
    const r2 = await runHash({ file: p2 });
    if (r1.result.ok && r2.result.ok) {
      expect(r1.result.data.sha256).not.toBe(r2.result.data.sha256);
      expect(r1.result.data.byte_count).toBe(5);
      expect(r2.result.data.byte_count).toBe(6);
    }
  });
});
