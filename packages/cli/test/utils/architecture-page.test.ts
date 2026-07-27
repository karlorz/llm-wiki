import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertArchitectureTargetInsideVault,
  prepareArchitecturePage,
  validateArchitectureTarget,
  validateProjectSlug,
} from "../../src/utils/architecture-page.js";

function archDraft(overrides: {
  type?: string;
  tags?: string[];
  provenance?: string;
  provenance_projects?: string[];
  title?: string;
} = {}): string {
  const type = overrides.type ?? "concept";
  const tags = overrides.tags ?? ["adr", "sync"];
  const provenance = overrides.provenance ?? "project";
  const projects = overrides.provenance_projects ?? ['"[[llm-wiki]]"'];
  const title = overrides.title ?? "Example ADR";
  return `---
title: ${title}
aliases: []
created: 2026-07-27
updated: 2026-07-27
type: ${type}
tags: [${tags.join(", ")}]
sources: [projects/llm-wiki/work/example/spec.md]
confidence: medium
provenance: ${provenance}
provenance_projects: [${projects.join(", ")}]
---

# ${title}

Body.
`;
}

describe("architecture-page target validation", () => {
  it("accepts exact projects/{slug}/architecture/{file}.md", () => {
    expect(validateArchitectureTarget("projects/llm-wiki/architecture/example.md", "llm-wiki").ok).toBe(true);
  });

  it("rejects missing project, absolute path, traversal, nesting, non-md", () => {
    expect(validateProjectSlug("").ok).toBe(false);
    expect(validateProjectSlug("Bad_Slug").ok).toBe(false);
    expect(validateArchitectureTarget("projects/llm-wiki/architecture/example.md", "other").ok).toBe(false);
    expect(validateArchitectureTarget("/abs/projects/llm-wiki/architecture/example.md", "llm-wiki").ok).toBe(false);
    expect(validateArchitectureTarget("projects/llm-wiki/architecture/../x.md", "llm-wiki").ok).toBe(false);
    expect(validateArchitectureTarget("projects/llm-wiki/architecture/nested/x.md", "llm-wiki").ok).toBe(false);
    expect(validateArchitectureTarget("projects/llm-wiki/architecture/example.txt", "llm-wiki").ok).toBe(false);
    expect(validateArchitectureTarget("concepts/example.md", "llm-wiki").ok).toBe(false);
  });

  it("rejects symlink targets and draft-target aliases", () => {
    const vault = mkdtempSync(join(tmpdir(), "arch-vault-"));
    mkdirSync(join(vault, "projects", "llm-wiki", "architecture"), { recursive: true });
    const target = "projects/llm-wiki/architecture/example.md";
    const abs = join(vault, target);
    writeFileSync(abs, archDraft());
    const linked = join(vault, "projects", "llm-wiki", "architecture", "linked.md");
    symlinkSync(abs, linked);
    expect(assertArchitectureTargetInsideVault(vault, "projects/llm-wiki/architecture/linked.md", "llm-wiki").ok).toBe(
      false,
    );
    const resolved = assertArchitectureTargetInsideVault(vault, target, "llm-wiki");
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.data.existingRealPath).toBeTruthy();
      expect(existsSync(resolved.data.absolutePath)).toBe(true);
      expect(lstatSync(resolved.data.absolutePath).isFile()).toBe(true);
    }
  });
});

describe("architecture-page metadata validation", () => {
  it("requires type concept and provenance project|mixed with project in provenance_projects", () => {
    const target = "projects/llm-wiki/architecture/example.md";
    expect(prepareArchitecturePage(archDraft(), target, "llm-wiki", { isNew: true }).ok).toBe(true);
    expect(prepareArchitecturePage(archDraft({ provenance: "mixed" }), target, "llm-wiki", { isNew: true }).ok).toBe(
      true,
    );
    expect(prepareArchitecturePage(archDraft({ type: "entity" }), target, "llm-wiki", { isNew: true }).ok).toBe(false);
    expect(prepareArchitecturePage(archDraft({ provenance: "research" }), target, "llm-wiki", { isNew: true }).ok).toBe(
      false,
    );
    expect(
      prepareArchitecturePage(archDraft({ provenance_projects: ['"[[other]]"'] }), target, "llm-wiki", {
        isNew: true,
      }).ok,
    ).toBe(false);
  });

  it("requires adr for new pages but allows legacy update without forced migration", () => {
    const target = "projects/llm-wiki/architecture/example.md";
    expect(
      prepareArchitecturePage(archDraft({ tags: ["sync"] }), target, "llm-wiki", { isNew: true }).ok,
    ).toBe(false);
    expect(
      prepareArchitecturePage(archDraft({ tags: ["sync"] }), target, "llm-wiki", { isNew: false }).ok,
    ).toBe(true);
  });

  it("rejects sensitive content", () => {
    const target = "projects/llm-wiki/architecture/example.md";
    const content = `${archDraft()}\napi_key: sk-${"a".repeat(24)}\n`;
    const sensitive = prepareArchitecturePage(content, target, "llm-wiki", { isNew: true });
    expect(sensitive.ok).toBe(false);
    if (!sensitive.ok) expect(sensitive.error).toBe("SENSITIVE_CONTENT_DETECTED");
  });
});
