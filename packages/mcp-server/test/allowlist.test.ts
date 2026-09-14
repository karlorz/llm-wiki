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

  it("allows log.md and dated log-event JSON for log_append only", () => {
    expect(isAllowedWritePath("log.md", "log_append")).toBe(true);
    expect(
      isAllowedWritePath(`meta/log-events/2026-09-14/${"a".repeat(64)}.json`, "log_append"),
    ).toBe(true);
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "log_append")).toBe(false);
    expect(isAllowedWritePath("meta/latest-session-brief.md", "log_append")).toBe(false);
    expect(isAllowedWritePath("meta/log-events/2026-09-14/not-a-hash.json", "log_append")).toBe(false);
    expect(isAllowedWritePath("meta/other.json", "log_append")).toBe(false);
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
    expect(isAllowedWritePath("raw/transcripts/2026-09-13-note-hello.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/../etc/passwd", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/work/2026-09-13-x/AGENTS.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/work/2026-09-13-x/notes/AGENTS.md", "workitem")).toBe(false);
  });

  it("allows Layer-3 workspace markdown families for workitem writes", () => {
    expect(isAllowedWritePath("projects/llm-wiki/README.md", "workitem")).toBe(true);
    expect(
      isAllowedWritePath("projects/llm-wiki/architecture/2026-09-14-topology.md", "workitem"),
    ).toBe(true);
    expect(isAllowedWritePath("projects/llm-wiki/architecture/sub/x.md", "workitem")).toBe(true);
    expect(isAllowedWritePath("projects/agentdock/requirements/functional.md", "workitem")).toBe(true);
    expect(isAllowedWritePath("projects/agentdock/requirements/sub/nested.md", "workitem")).toBe(true);
    expect(isAllowedWritePath("projects/llm-wiki/compound/lessons.md", "workitem")).toBe(true);
    expect(isAllowedWritePath("projects/llm-wiki/compound/sub/pattern.md", "workitem")).toBe(true);
  });

  it("keeps non-family workspace paths denied for workitem writes", () => {
    expect(isAllowedWritePath("projects/llm-wiki/history/x.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/history/specs/old-spec.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/fleet.yaml", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/architecture/x.canvas", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/AGENTS.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/CLAUDE.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/architecture/AGENTS.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/architecture/../../../log.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/notes.md", "workitem")).toBe(false);
    expect(isAllowedWritePath("projects/llm-wiki/readme.md", "workitem")).toBe(false);
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

  it("denies .obsidian and .skillwiki path segments for capture, log_append, workitem, and page_publish", () => {
    const cases: Array<[Parameters<typeof isAllowedWritePath>[1], string]> = [
      ["capture", "raw/transcripts/.obsidian/2026-09-13-note-hello.md"],
      ["capture", "raw/.skillwiki/transcripts/2026-09-13-note-hello.md"],
      ["log_append", `meta/.obsidian/log-events/2026-09-14/${"a".repeat(64)}.json`],
      ["log_append", ".skillwiki/log.md"],
      ["workitem", "projects/llm-wiki/work/2026-09-13-tier2/.obsidian/spec.md"],
      ["workitem", "projects/llm-wiki/architecture/.skillwiki/x.md"],
      ["page_publish", "concepts/foo/.obsidian/x.md"],
      ["page_publish", "concepts/foo/.skillwiki/x.md"],
    ];
    for (const [kind, path] of cases) {
      expect(isAllowedWritePath(path, kind), `${kind} ${path}`).toBe(false);
    }
  });
});
