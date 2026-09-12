import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedWritePath,
  isForbiddenWriteName,
  resolveWithinVault,
} from "../src/allowlist.js";

describe("boundary-aware vault paths", () => {
  const vault = join("/opt", "skillwiki-mcp", "vault");

  it("accepts a path under the vault root", () => {
    expect(resolveWithinVault(vault, "raw/transcripts/note.md")).toBe(
      join(vault, "raw", "transcripts", "note.md"),
    );
  });

  it("rejects a sibling directory that shares a prefix (not naive startsWith)", () => {
    expect(resolveWithinVault(vault, "../vault-evil/secret.md")).toBeNull();
    expect(resolveWithinVault("/opt/skillwiki-mcp/vault-evil", join("/opt/skillwiki-mcp/vault-evil", "x.md"))).not.toBeNull();
    expect(resolveWithinVault(vault, join("/opt/skillwiki-mcp", "vault-evil", "x.md"))).toBeNull();
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
  });
});
