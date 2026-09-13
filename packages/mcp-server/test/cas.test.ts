import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileChangedError } from "../src/txn.js";
import { wikiPagePublish, wikiWorkitemWrite } from "../src/tools/writes.js";
import { ReconcileGate } from "../src/reconcile.js";
import { makeTempVault } from "./helpers.js";

function readyGate(): ReconcileGate {
  return new ReconcileGate(async () => undefined);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

describe("Tier 2 CAS error shape scaffold", () => {
  it("returns StashBase-style FILE_CHANGED with sha256 currentVersion", () => {
    expect(fileChangedError("projects/x/knowledge.md", "ab".repeat(32))).toEqual({
      error: "FILE_CHANGED",
      currentVersion: `sha256:${"ab".repeat(32)}`,
      path: "projects/x/knowledge.md",
    });
  });
});

describe("wiki_workitem_write CAS", () => {
  it("creates knowledge.md when the path is absent and base_sha256 is omitted", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    await mkdir(join(vault, "projects", "llm-wiki"), { recursive: true });
    const body = "---\ntitle: k\n---\nbody\n";
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: "projects/llm-wiki/knowledge.md", content: body },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.path).toBe("projects/llm-wiki/knowledge.md");
    expect(await readFile(join(vault, "projects/llm-wiki/knowledge.md"), "utf8")).toBe(body);
  });

  it("overwrites when base_sha256 matches file bytes", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/work/2026-09-13-tier2/spec.md";
    await mkdir(join(vault, "projects/llm-wiki/work/2026-09-13-tier2"), { recursive: true });
    const original = "---\nstatus: planned\n---\nold\n";
    await writeFile(join(vault, rel), original, "utf8");
    const next = "---\nstatus: completed\ncompleted: 2026-09-13\n---\nnew\n";
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: next, base_sha256: sha256Utf8(original) },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(vault, rel), "utf8")).toBe(next);
  });

  it("returns FILE_CHANGED with currentVersion on hash mismatch", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/knowledge.md";
    await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
    const original = "current\n";
    await writeFile(join(vault, rel), original, "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: "other\n", base_sha256: "00".repeat(32) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("FILE_CHANGED");
    expect(result).toMatchObject({
      currentVersion: `sha256:${sha256Utf8(original)}`,
      path: rel,
    });
    expect(JSON.stringify(result)).not.toMatch(/Bearer|sk-/);
    expect(await readFile(join(vault, rel), "utf8")).toBe(original);
  });

  it("rejects create when the path already exists and base_sha256 is omitted", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/knowledge.md";
    await mkdir(join(vault, "projects/llm-wiki"), { recursive: true });
    await writeFile(join(vault, rel), "keep\n", "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: "nope\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
  });
});

describe("wiki_page_publish CAS", () => {
  it("overwrites a typed page when the hash matches", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const original = await readFile(join(vault, "concepts/alpha.md"), "utf8");
    const next = original.replace("Alpha concept body.", "Updated body.");
    const result = await wikiPagePublish(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: "concepts/alpha.md", content: next, base_sha256: sha256Utf8(original) },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(vault, "concepts/alpha.md"), "utf8")).toBe(next);
  });

  it("denies raw/ paths", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const result = await wikiPagePublish(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: "raw/transcripts/nope.md", content: "x\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("PATH_DENIED");
  });
});

