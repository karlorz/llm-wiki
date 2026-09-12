import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitWrite } from "../src/txn.js";
import { makeTempVault } from "./helpers.js";

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
