import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedWritePath,
  isForbiddenWriteName,
  resolveWithinVault,
} from "../src/allowlist.js";

describe("boundary-aware vault paths", () => {
  const vault = resolve("/opt/skillwiki-mcp/vault");

  it("accepts a path under the vault root", () => {
    expect(resolveWithinVault(vault, "raw/transcripts/note.md")).toBe(
      resolve(vault, "raw", "transcripts", "note.md"),
    );
  });

  it("rejects a sibling directory that shares a prefix (not naive startsWith)", () => {
    expect(resolveWithinVault(vault, "../vault-evil/secret.md")).toBeNull();
    const evil = resolve("/opt/skillwiki-mcp/vault-evil");
    expect(resolveWithinVault(evil, join(evil, "x.md"))).not.toBeNull();
    expect(resolveWithinVault(vault, join(resolve("/opt/skillwiki-mcp"), "vault-evil", "x.md"))).toBeNull();
  });

  it("rejects NUL bytes and backslash-normalized escapes", () => {
    expect(resolveWithinVault(vault, "raw/\0transcripts/x.md")).toBeNull();
  });
});

describe("write allowlist", () => {
  it("allows new capture files under raw/transcripts", () => {
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "capture")).toBe(true);
  });

  it("rejects captures outside transcripts or with the wrong kind", () => {
    expect(isAllowedWritePath("raw/articles/2026-09-13-note-hello.md", "capture")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/knowledge.md", "capture")).toBe(false);
    expect(isAllowedWritePath("log.md", "capture")).toBe(false);
  });

  it("allows log.md for log_append only", () => {
    expect(isAllowedWritePath("log.md", "log_append")).toBe(true);
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "log_append")).toBe(false);
  });

  it("never allows AGENTS.md or CLAUDE.md", () => {
    expect(isForbiddenWriteName("AGENTS.md")).toBe(true);
    expect(isForbiddenWriteName("CLAUDE.md")).toBe(true);
    expect(isForbiddenWriteName("projects/x/AGENTS.md")).toBe(true);
    expect(isForbiddenWriteName("projects/x/work/2026-09-13-t/notes/AGENTS.md")).toBe(true);
  });

  it("allows work-item markdown including nested paths and project knowledge.md", () => {
    expect(
      isAllowedWritePath("projects/llm-wiki/work/2026-09-13-tier2/spec.md", "workitem"),
    ).toBe(true);
    expect(
      isAllowedWritePath("projects/llm-wiki/work/2026-09-13-tier2/notes/close.md", "workitem"),
    ).toBe(true);
    expect(isAllowedWritePath("projects/llm-wiki/knowledge.md", "workitem")).toBe(true);
  });

  it("rejects workitem paths outside allowlist, traversal, and raw/", () => {
    expect(isAllowedWritePath("projects/llm-wiki/README.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/../etc/passwd", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/work/2026-09-13-x/AGENTS.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/work/2026-09-13-x/notes/AGENTS.md", "workitem")).toBe(false);
  });

  it("allows typed Layer-2 pages for page_publish including nested paths", () => {
    expect(isAllowedWritePath("concepts/alpha.md", "page_publish")).toBe(true);
    expect(isAllowedWritePath("queries/2026-09-13-example.md", "page_publish")).toBe(true);
    expect(isAllowedWritePath("concepts/foo/bar.md", "page_publish")).toBe(true);
  });

  it("rejects page_publish of uppercase paths, raw/, and work items", () => {
    expect(isAllowedWritePath("Concepts/Alpha.md", "page_publish")).toBe(false);
    expect(isAllowedWritePath("concepts/Alpha.md", "page_publish")).toBe(false);
    expect(isAllowedWritePath("concepts/foo/Bar.md", "page_publish")).toBe(false);
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "page_publish")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/knowledge.md", "page_publish")).toBe(false);
    expect(isAllowedWritePath("log.md", "page_publish")).toBe(false);
  });
});
