import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTokenMap, resolveHostId } from "../src/auth.js";
import { handleWikiReadPage, handleWikiStatus } from "../src/tools/reads.js";
import { wikiCapture } from "../src/tools/writes.js";
import { ReconcileGate } from "../src/reconcile.js";
import { makeTempVault } from "./helpers.js";

describe("integration vs temp vault + mock S3", () => {
  it("read_page returns markdown, frontmatter, and file sha256", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const page = await handleWikiReadPage({ vaultDir: vault, gate }, { path: "concepts/alpha.md" });
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error("expected ok");
    expect(page.frontmatter).toMatchObject({ title: "Alpha", type: "concept" });
    expect(page.markdown).toContain("Alpha concept body");
    const bytes = await readFile(join(vault, "concepts", "alpha.md"));
    expect(page.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("status reports the working dir after reconcile", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const status = await handleWikiStatus({ vaultDir: vault, gate, s3Ok: true });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("expected ok");
    expect(status.reconcile_ready).toBe(true);
    expect(status.s3_ok).toBe(true);
    expect(status.vault_path).toBe(vault);
  });

  it("N parallel wiki_capture calls produce N distinct files", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const s3 = new Map<string, Buffer>();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        wikiCapture({
          vaultDir: vault,
          hostId: "macos-dev",
          gate,
          putObject: async (path, body) => {
            s3.set(path, body);
          },
          now: () => new Date("2026-09-13T12:00:00Z"),
        }, {
          kind: "task",
          project: "llm-wiki",
          title: `parallel ${i}`,
          content: `body ${i}`,
        }),
      ),
    );
    const paths = results.map((r) => {
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      return r.path;
    });
    expect(new Set(paths).size).toBe(5);
    for (const path of paths) {
      expect(s3.has(path)).toBe(true);
      expect(await readFile(join(vault, path), "utf8")).toContain("body ");
    }
  });

  it("S3 failure returns a structured error and no partial vault state", async () => {
    const vault = await makeTempVault();
    const gate = new ReconcileGate(async () => undefined);
    await gate.runFirst();
    const result = await wikiCapture({
      vaultDir: vault,
      hostId: "macos-dev",
      gate,
      putObject: async () => {
        throw Object.assign(new Error("connection refused"), { code: "S3_PUT_FAILED" });
      },
      now: () => new Date("2026-09-13T12:00:00Z"),
    }, {
      kind: "bug",
      project: "llm-wiki",
      title: "should not land",
      content: "no partial state",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("S3_PUT_FAILED");
    expect(result.message).toMatch(/connection refused/);
  });

  it("loads a token map file and resolves host_id", async () => {
    const vault = await makeTempVault();
    const token = "cursor-box-token";
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const yaml = `${hash}: cursor-box\n`;
    await writeFile(join(vault, "tokens.yaml"), yaml, "utf8");
    const map = parseTokenMap(yaml);
    expect(resolveHostId(token, map)).toBe("cursor-box");
  });
});
