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
    expect(await readFile(join(vault, rel), "utf8")).toBe(
      "---\nstatus: completed\ncompleted: 2026-09-13\nhost: macos-dev\n---\nnew\n",
    );
  });

  it("stamps role and id and replaces existing frontmatter fields on spec/plan overwrite", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/work/2026-09-13-tier2/plan.md";
    await mkdir(join(vault, "projects/llm-wiki/work/2026-09-13-tier2"), { recursive: true });
    const original = "---\nstatus: planned\nhost: old-host\nagent_role: old-role\nagent_id: old-id\n---\nold\n";
    await writeFile(join(vault, rel), original, "utf8");
    const next = "---\nstatus: in-progress\nhost: ignore-host\nagent_role: ignore-role\n---\nupdated body\n";
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      {
        path: rel,
        content: next,
        base_sha256: sha256Utf8(original),
        agent_role: "worker",
        agent_id: "agent-1",
      },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(vault, rel), "utf8")).toBe(
      "---\nstatus: in-progress\nhost: macos-dev\nagent_role: worker\nagent_id: agent-1\n---\nupdated body\n",
    );
  });

  it("rejects malformed spec frontmatter with INVALID_FRONTMATTER without writing", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/work/2026-09-13-tier2/spec.md";
    await mkdir(join(vault, "projects/llm-wiki/work/2026-09-13-tier2"), { recursive: true });
    const original = "---\nstatus: planned\n---\nbody\n";
    await writeFile(join(vault, rel), original, "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: "no-frontmatter\n", base_sha256: sha256Utf8(original) },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("INVALID_FRONTMATTER");
    expect(await readFile(join(vault, rel), "utf8")).toBe(original);
  });

  it("leaves architecture content unchanged without host stamping", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/architecture/2026-09-14-topology.md";
    await mkdir(join(vault, "projects/llm-wiki/architecture"), { recursive: true });
    const original = "---\ntitle: topology\n---\nold\n";
    await writeFile(join(vault, rel), original, "utf8");
    const next = "---\ntitle: topology\n---\nnew\n";
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: next, base_sha256: sha256Utf8(original), agent_role: "worker" },
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(vault, rel), "utf8")).toBe(next);
  });

  it("rejects invalid identity tokens without writing", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/work/2026-09-13-tier2/spec.md";
    await mkdir(join(vault, "projects/llm-wiki/work/2026-09-13-tier2"), { recursive: true });
    const original = "---\nstatus: planned\n---\nbody\n";
    await writeFile(join(vault, rel), original, "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      {
        path: rel,
        content: "---\nstatus: in-progress\n---\nbody\n",
        base_sha256: sha256Utf8(original),
        agent_role: "invalid role with spaces",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
    expect(result.message).toContain("invalid agent_role");
    expect(await readFile(join(vault, rel), "utf8")).toBe(original);
  });

  it("rejects sensitive identity values without writing", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const rel = "projects/llm-wiki/work/2026-09-13-tier2/spec.md";
    await mkdir(join(vault, "projects/llm-wiki/work/2026-09-13-tier2"), { recursive: true });
    const original = "---\nstatus: planned\n---\nbody\n";
    await writeFile(join(vault, rel), original, "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      {
        path: rel,
        content: "---\nstatus: in-progress\n---\nbody\n",
        base_sha256: sha256Utf8(original),
        agent_id: "sk-live-agent-token-1234567890abcdef",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("SENSITIVE_CONTENT_DETECTED");
    expect(await readFile(join(vault, rel), "utf8")).toBe(original);
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

describe("wiki_workitem_write CAS on Layer-3 workspace paths", () => {
  const rel = "projects/llm-wiki/architecture/2026-09-14-topology.md";

  it("creates an architecture page when the path is absent and base_sha256 is omitted", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const body = "---\ntitle: topology\n---\nExtract body.\n";
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: body },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.path).toBe(rel);
    expect(await readFile(join(vault, rel), "utf8")).toBe(body);
  });

  it("rejects overwrite of an existing architecture page without base_sha256", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    await mkdir(join(vault, "projects/llm-wiki/architecture"), { recursive: true });
    await writeFile(join(vault, rel), "keep\n", "utf8");
    const result = await wikiWorkitemWrite(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: rel, content: "nope\n" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
    expect(await readFile(join(vault, rel), "utf8")).toBe("keep\n");
  });

  it("returns FILE_CHANGED with currentVersion on stale architecture hash", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    await mkdir(join(vault, "projects/llm-wiki/architecture"), { recursive: true });
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
    expect(await readFile(join(vault, rel), "utf8")).toBe(original);
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

  it("rejects overwrite of an existing typed page without base_sha256", async () => {
    const vault = await makeTempVault();
    const gate = readyGate();
    await gate.runFirst();
    const original = await readFile(join(vault, "concepts/alpha.md"), "utf8");
    const result = await wikiPagePublish(
      { vaultDir: vault, hostId: "macos-dev", gate, putObject: async () => undefined },
      { path: "concepts/alpha.md", content: original.replace("Alpha concept body.", "clobber") },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("USAGE");
    expect((result as { writer_id?: string }).writer_id).toBeUndefined();
    expect(await readFile(join(vault, "concepts/alpha.md"), "utf8")).toBe(original);
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

