import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicCopyWithBackup, writeManifest } from "../../src/utils/install-fs.js";

describe("install-fs", () => {
  it("copies a file when target absent", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    writeFileSync(join(src, "f.md"), "v1");
    const r = await atomicCopyWithBackup(join(src, "f.md"), join(dst, "f.md"));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dst, "f.md"), "utf8")).toBe("v1");
  });

  it("backs up an existing target before overwrite", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    writeFileSync(join(src, "f.md"), "v2");
    writeFileSync(join(dst, "f.md"), "v1");
    const r = await atomicCopyWithBackup(join(src, "f.md"), join(dst, "f.md"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(existsSync(r.data.backupPath!)).toBe(true);
    expect(readFileSync(join(dst, "f.md"), "utf8")).toBe("v2");
  });

  it("writes a manifest as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "man-"));
    const path = join(dir, "wiki-manifest.json");
    await writeManifest(path, { installed: ["a"], backed_up: [] });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.installed).toEqual(["a"]);
  });

  it("returns backupPath null when no prior target exists", async () => {
    const src = mkdtempSync(join(tmpdir(), "src-"));
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    writeFileSync(join(src, "f.md"), "content");
    const r = await atomicCopyWithBackup(join(src, "f.md"), join(dst, "f.md"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.backupPath).toBeNull();
  });

  it("returns ATOMIC_COPY_FAILED when source file does not exist", async () => {
    const dst = mkdtempSync(join(tmpdir(), "dst-"));
    const r = await atomicCopyWithBackup("/no/such/source.md", join(dst, "out.md"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("ATOMIC_COPY_FAILED");
  });

  it("enriches manifest with installed_at timestamp", async () => {
    const dir = mkdtempSync(join(tmpdir(), "man-"));
    const path = join(dir, "wiki-manifest.json");
    const before = new Date();
    await writeManifest(path, { installed: ["x"], backed_up: ["y"] });
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.installed_at).toBeDefined();
    expect(new Date(data.installed_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(data.backed_up).toEqual(["y"]);
  });
});
