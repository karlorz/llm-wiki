import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentVersion, type GetObject, type S3Adapter } from "../src/versions.js";
import { commitCasWrite, fileChangedError, type PutObject, S3PutError } from "../src/txn.js";
import { handleWikiReadPage } from "../src/tools/reads.js";
import { wikiWorkitemWrite } from "../src/tools/writes.js";
import { ReconcileGate } from "../src/reconcile.js";
import { makeTempVault } from "./helpers.js";

function readyGate(): ReconcileGate {
  return new ReconcileGate(async () => undefined);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function makeS3Store(initial: Record<string, string> = {}) {
  const store = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, Buffer.from(v, "utf8"));
  }
  const getObject: GetObject = async (relPath: string) => {
    const found = store.get(relPath);
    if (!found) return null;
    return {
      sha256: createHash("sha256").update(found).digest("hex"),
      body: found,
    };
  };
  const putObject: PutObject = async (relPath: string, body: Buffer) => {
    store.set(relPath, body);
  };
  return { store, getObject, putObject };
}

describe("C1 S3 version authority (TDD RED)", () => {
  describe("currentVersion", () => {
    it("returns sha256 of S3 object and refreshes working copy on divergence", async () => {
      const vault = await makeTempVault();
      const rel = "concepts/alpha.md";
      const s3Content = "s3 fresh version\n";
      const s3 = makeS3Store({ [rel]: s3Content });

      // Working copy originally has different content
      const localOriginal = await readFile(join(vault, rel), "utf8");
      expect(localOriginal).not.toBe(s3Content);

      const ver = await currentVersion(
        { vaultDir: vault, getObject: s3.getObject },
        rel,
      );

      expect(ver.absent).toBe(false);
      expect(ver.sha256).toBe(sha256Utf8(s3Content));
      // Working copy should have been refreshed to S3 version
      expect(await readFile(join(vault, rel), "utf8")).toBe(s3Content);
    });

    it("returns absent: true and working copy hash if absent on S3", async () => {
      const vault = await makeTempVault();
      const rel = "concepts/absent.md";
      const s3 = makeS3Store();

      const ver = await currentVersion(
        { vaultDir: vault, getObject: s3.getObject },
        rel,
      );

      expect(ver.absent).toBe(true);
      expect(ver.sha256).toBe("absent");
    });

    it("throws S3PutError when S3 is unreachable", async () => {
      const vault = await makeTempVault();
      const rel = "concepts/alpha.md";
      const failingGet: GetObject = async () => {
        throw new S3PutError("S3 connection timeout");
      };

      await expect(
        currentVersion({ vaultDir: vault, getObject: failingGet }, rel),
      ).rejects.toMatchObject({ code: "S3_PUT_FAILED" });
    });

    it("with no getObject reads the working copy and returns absent on ENOENT", async () => {
      const vault = await makeTempVault();
      const rel = "concepts/alpha.md";
      const localContent = await readFile(join(vault, rel), "utf8");

      const present = await currentVersion({ vaultDir: vault }, rel);
      expect(present.absent).toBe(false);
      expect(present.sha256).toBe(sha256Utf8(localContent));
      expect(present.bytes?.toString("utf8")).toBe(localContent);

      const missing = await currentVersion({ vaultDir: vault }, "concepts/no-such.md");
      expect(missing.absent).toBe(true);
      expect(missing.sha256).toBe("absent");
    });
  });

  describe("commitCasWrite with S3 authority", () => {
    it("stale-base CAS returns FILE_CHANGED with currentVersion = sha256(B) and refreshes working copy", async () => {
      const vault = await makeTempVault();
      const rel = "projects/llm-wiki/knowledge.md";
      const contentA = "version A in working copy\n";
      const contentB = "version B in S3 (human push)\n";

      // Seed working copy A
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
      await writeFile(join(vault, rel), contentA, "utf8");

      // Seed S3 with B
      const s3 = makeS3Store({ [rel]: contentB });

      // Try CAS with base_sha256 = sha256(A)
      const res = await commitCasWrite(
        {
          vaultDir: vault,
          putObject: s3.putObject,
          getObject: s3.getObject,
        },
        { relPath: rel, content: "version C\n" },
        sha256Utf8(contentA),
      );

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("expected failure");
      expect(res.error).toBe("FILE_CHANGED");
      if (res.error !== "FILE_CHANGED") throw new Error("expected FILE_CHANGED");
      expect(res.currentVersion).toBe(`sha256:${sha256Utf8(contentB)}`);

      // Working copy after check matches B (single-path refresh)
      expect(await readFile(join(vault, rel), "utf8")).toBe(contentB);
    });

    it("fresh-base CAS (hash of B) succeeds and writes C to both S3 and working copy", async () => {
      const vault = await makeTempVault();
      const rel = "projects/llm-wiki/knowledge.md";
      const contentB = "version B in S3\n";
      const contentC = "version C write\n";

      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
      await writeFile(join(vault, rel), contentB, "utf8");
      const s3 = makeS3Store({ [rel]: contentB });

      const res = await commitCasWrite(
        {
          vaultDir: vault,
          putObject: s3.putObject,
          getObject: s3.getObject,
        },
        { relPath: rel, content: contentC },
        sha256Utf8(contentB),
      );

      expect(res.ok).toBe(true);
      expect(await readFile(join(vault, rel), "utf8")).toBe(contentC);
      expect(s3.store.get(rel)?.toString("utf8")).toBe(contentC);
    });

    it("S3 unreachable during CAS: fails closed, working copy unchanged", async () => {
      const vault = await makeTempVault();
      const rel = "projects/llm-wiki/knowledge.md";
      const contentA = "original working copy\n";

      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
      await writeFile(join(vault, rel), contentA, "utf8");

      const failingGet: GetObject = async () => {
        throw new S3PutError("connection refused");
      };

      await expect(
        commitCasWrite(
          {
            vaultDir: vault,
            putObject: async () => undefined,
            getObject: failingGet,
          },
          { relPath: rel, content: "new content\n" },
          sha256Utf8(contentA),
        ),
      ).rejects.toMatchObject({ code: "S3_PUT_FAILED" });

      // Working copy unchanged
      expect(await readFile(join(vault, rel), "utf8")).toBe(contentA);
    });
  });

  describe("handleWikiReadPage with S3 authority", () => {
    it("read with divergence: sha256 is S3's and s3_verified: true, refreshes working copy", async () => {
      const vault = await makeTempVault();
      const gate = readyGate();
      await gate.runFirst();
      const rel = "concepts/alpha.md";
      const s3Content = "---\ntitle: S3 Alpha\ntype: concept\n---\nS3 Alpha body\n";
      const s3 = makeS3Store({ [rel]: s3Content });

      const res = await handleWikiReadPage(
        { vaultDir: vault, gate, getObject: s3.getObject },
        { path: rel },
      );

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.sha256).toBe(sha256Utf8(s3Content));
      expect(res.s3_verified).toBe(true);
      expect(res.markdown).toBe(s3Content);
      expect(await readFile(join(vault, rel), "utf8")).toBe(s3Content);
    });

    it("read when S3 unreachable: serves working copy bytes with s3_verified: false", async () => {
      const vault = await makeTempVault();
      const gate = readyGate();
      await gate.runFirst();
      const rel = "concepts/alpha.md";
      const localContent = await readFile(join(vault, rel), "utf8");

      const failingGet: GetObject = async () => {
        throw new S3PutError("S3 offline");
      };

      const res = await handleWikiReadPage(
        { vaultDir: vault, gate, getObject: failingGet },
        { path: rel },
      );

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error("expected ok");
      expect(res.sha256).toBe(sha256Utf8(localContent));
      expect(res.s3_verified).toBe(false);
      expect(res.markdown).toBe(localContent);
    });
  });

  describe("wikiWorkitemWrite end-to-end with S3 authority", () => {
    it("fails closed when S3 unreachable during workitem CAS write", async () => {
      const vault = await makeTempVault();
      const gate = readyGate();
      await gate.runFirst();
      const rel = "projects/llm-wiki/knowledge.md";
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
      await writeFile(join(vault, rel), "local knowledge\n", "utf8");

      const failingGet: GetObject = async () => {
        throw new S3PutError("S3 offline");
      };

      const result = await wikiWorkitemWrite(
        {
          vaultDir: vault,
          hostId: "macos-dev",
          gate,
          putObject: async () => undefined,
          getObject: failingGet,
        },
        { path: rel, content: "next knowledge\n", base_sha256: sha256Utf8("local knowledge\n") },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toBe("S3_PUT_FAILED");
      expect(await readFile(join(vault, rel), "utf8")).toBe("local knowledge\n");
    });
  });
});
