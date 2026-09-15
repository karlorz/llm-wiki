import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitWrite, normalizeSha256, writeAtomicPath } from "../src/txn.js";
import { makeTempVault } from "./helpers.js";

describe("normalizeSha256", () => {
  it("trims, strips a sha256: prefix, and lowercases", () => {
    expect(normalizeSha256("  SHA256:ABCDEF0123456789  ")).toBe("abcdef0123456789");
  });
});

describe("write transaction", () => {
  it("puts to S3 then moves into the working dir", async () => {
    const vault = await makeTempVault();
    const put: string[] = [];
    const rel = "raw/transcripts/2026-09-13-note-txn.md";
    await commitWrite({
      vaultDir: vault,
      putObject: async (path, body) => {
        put.push(path);
        expect(body.toString("utf8")).toContain("kind: note");
      },
    }, [{ relPath: rel, content: "---\nsource_url: null\ningested: 2026-09-13\nkind: note\n---\n# note: txn\n" }]);
    expect(put).toEqual([rel]);
    expect(await readFile(join(vault, rel), "utf8")).toContain("# note: txn");
  });

  it("discards temp and leaves the working dir unchanged when S3 put fails", async () => {
    const vault = await makeTempVault();
    const rel = "raw/transcripts/2026-09-13-note-fail.md";
    await expect(
      commitWrite({
        vaultDir: vault,
        putObject: async () => {
          throw Object.assign(new Error("S3 unavailable"), { code: "S3_PUT_FAILED" });
        },
      }, [{ relPath: rel, content: "---\nsource_url: null\ningested: 2026-09-13\nkind: note\n---\nsecret\n" }]),
    ).rejects.toMatchObject({ code: "S3_PUT_FAILED" });
    await expect(access(join(vault, rel))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards temp and leaves the working dir unchanged when writeAtomicPath rename fails", async () => {
    const vault = await makeTempVault();
    const target = join(vault, "concepts", "move-fail.md");
    const original = "keep original\n";
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, original, "utf8");
    // Destination already exists as a directory, so rename(temp-file, target) fails after writeTemp.
    await mkdir(join(vault, "concepts", "move-fail-dir"), { recursive: true });
    await writeFile(join(vault, "concepts", "move-fail-dir", "keep.md"), "nested-keep\n", "utf8");
    const blocked = join(vault, "concepts", "move-fail-dir");

    await expect(writeAtomicPath(blocked, "should-not-land\n")).rejects.toMatchObject({
      code: expect.stringMatching(/^(EISDIR|EPERM)$/),
    });

    expect(await readFile(join(blocked, "keep.md"), "utf8")).toBe("nested-keep\n");
    expect(await readFile(target, "utf8")).toBe(original);
    const leftovers = (await readdir(join(vault, "concepts"))).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serializes N parallel commits so every file lands intact", async () => {
    const vault = await makeTempVault();
    const order: string[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const n = 8;
    await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const rel = `raw/transcripts/2026-09-13-note-p${i}.md`;
        return commitWrite({
          vaultDir: vault,
          putObject: async (path) => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((r) => setTimeout(r, 15));
            order.push(path);
            inflight -= 1;
          },
        }, [{ relPath: rel, content: `---\nsource_url: null\ningested: 2026-09-13\nkind: note\n---\n# p${i}\n` }]);
      }),
    );
    expect(maxInflight).toBe(1);
    expect(order).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      const text = await readFile(join(vault, `raw/transcripts/2026-09-13-note-p${i}.md`), "utf8");
      expect(text).toContain(`# p${i}`);
    }
  });
});
