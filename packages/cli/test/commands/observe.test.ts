import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ExitCode } from "@skillwiki/shared";
import { runObserve } from "../../src/commands/observe.js";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-"));
  writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
  mkdirSync(join(dir, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(dir, "concepts"), { recursive: true });
  return dir;
}

function hashBody(body: string): string {
  return createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
}

describe("runObserve", () => {
  it("creates observation with valid frontmatter and sha256", async () => {
    const dir = makeVault();
    const text = "Discovered a pattern in how agents handle retry logic";
    const r = await runObserve({ vault: dir, text });

    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const { path: relPath, sha256 } = r.result.data;
    expect(relPath).toMatch(/^raw\/transcripts\/\d{4}-\d{2}-\d{2}-observation-/);
    expect(relPath).toContain("discovered-a-pattern-in-how-agents");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    const fullPath = join(dir, relPath);
    expect(existsSync(fullPath)).toBe(true);

    const content = readFileSync(fullPath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();

    const fm = fmMatch![1];
    expect(fm).toContain("source_url:");
    expect(fm).toContain(`sha256: ${sha256}`);
    expect(fm).toContain("kind: note");
    expect(fm).toMatch(/ingested: \d{4}-\d{2}-\d{2}/);

    const body = content.split("---").slice(2).join("---");
    const expectedHash = hashBody(body);
    expect(sha256).toBe(expectedHash);
  });

  it("defaults kind to note", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "some note text here" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain("kind: note");
  });

  it("sets kind when provided", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "a bug was found", kind: "bug" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain("kind: bug");
  });

  it("sets project wikilink when --project provided", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "project observation", project: "llm-wiki" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain('project: "[[llm-wiki]]"');
  });

  it("omits project line when --project not provided", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "no project here" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).not.toContain("project:");
  });

  it("returns VAULT_PATH_INVALID for missing vault", async () => {
    const r = await runObserve({ vault: "/nonexistent/path/vault", text: "some text" });
    expect(r.exitCode).toBe(9);
    expect(r.result.ok).toBe(false);
  });

  it("rejects invalid kind values", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "test", kind: "invalid-kind" });
    expect(r.exitCode).toBe(4);
    expect(r.result.ok).toBe(false);
  });

  it("rejects empty text", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "" });
    expect(r.exitCode).toBe(4);
    expect(r.result.ok).toBe(false);
  });

  it("creates raw/transcripts/ directory if missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-"));
    writeFileSync(join(dir, "SCHEMA.md"), "# Vault Schema\n");
    // No raw/transcripts/ created — observe should create it
    const r = await runObserve({ vault: dir, text: "auto-created dir" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");
    expect(existsSync(join(dir, "raw", "transcripts"))).toBe(true);
  });

  it("creates observation without project", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "standalone observation" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    const projectLines = lines.filter((l) => /^project:/.test(l));
    expect(projectLines).toHaveLength(0);
  });

  it("rejects text that is only whitespace", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "   " });
    expect(r.exitCode).toBe(ExitCode.SCHEME_REJECTED);
    expect(r.result.ok).toBe(false);
  });

  it("slugifies long text correctly", async () => {
    const dir = makeVault();
    const longText = "one two three four five six seven eight nine ten eleven";
    const r = await runObserve({ vault: dir, text: longText });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fileName = r.result.data.path.split("/").pop()!;
    // FileName is like 2026-05-09-observation-one-two-three-four-five-six.md
    // Extract the slug portion after "observation-"
    const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-observation-(.+)\.md$/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch![1];
    const wordCount = slug.split("-").length;
    expect(wordCount).toBeLessThanOrEqual(6);
  });

  it("slugifies special characters", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "Fix: the `config` command!" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fileName = r.result.data.path.split("/").pop()!;
    const slugMatch = fileName.match(/^\d{4}-\d{2}-\d{2}-observation-(.+)\.md$/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch![1];
    // Only lowercase letters, digits, and hyphens allowed
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).toBe("fix-the-config-command");
  });

  it("writes file to raw/transcripts directory", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "file path check" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const relPath = r.result.data.path;
    expect(relPath).toMatch(
      /^raw\/transcripts\/\d{4}-\d{2}-\d{2}-observation-file-path-check\.md$/
    );
    expect(existsSync(join(dir, relPath))).toBe(true);
  });

  it("computes correct sha256 hash", async () => {
    const dir = makeVault();
    const text = "verify sha256 independently";
    const r = await runObserve({ vault: dir, text });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const { sha256 } = r.result.data;
    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");

    // Body is everything after the second "---"
    const body = content.split("---").slice(2).join("---");
    const expectedHash = hashBody(body);
    expect(sha256).toBe(expectedHash);
  });

  it("accepts task as a valid kind", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "need to fix config", kind: "task" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain("kind: task");
  });

  it("accepts idea as a valid kind", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "new approach for caching", kind: "idea" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain("kind: idea");
  });

  it("accepts session-log as a valid kind", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "session started", kind: "session-log" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fullPath = join(dir, r.result.data.path);
    const content = readFileSync(fullPath, "utf8");
    expect(content).toContain("kind: session-log");
  });

  it("generates humanHint with relative path and truncated sha256", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "hint check observation" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const hint = r.result.data.humanHint;
    expect(hint).toContain("raw/transcripts/");
    expect(hint).toContain("...");  // sha256 is truncated in hint
  });

  it("produces untitled slug when text has only special characters", async () => {
    const dir = makeVault();
    const r = await runObserve({ vault: dir, text: "@#$%^&" });
    expect(r.exitCode).toBe(0);
    if (!r.result.ok) throw new Error("expected ok");

    const fileName = r.result.data.path.split("/").pop()!;
    expect(fileName).toContain("observation-untitled");
  });
});
