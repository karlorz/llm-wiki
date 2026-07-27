import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const REQUIRED = [
  "packages/skills/using-skillwiki/SKILL.md",
  "packages/skills/wiki-query/SKILL.md",
  "packages/skills/wiki-ingest/SKILL.md",
  "packages/skills/agents/wiki-query.md",
  "packages/skills/agents/wiki-ingest.md",
  "packages/skills/wiki-archive/SKILL.md",
  "packages/skills/wiki-crystallize/SKILL.md",
  "packages/skills/proj-work/SKILL.md",
];
const PASTED_TEXT_INGEST_SOURCES = [
  "packages/skills/wiki-ingest/SKILL.md",
  "packages/skills/agents/wiki-ingest.md",
];

describe("managed writer publication contract", () => {
  for (const relative of REQUIRED) {
    it(`${relative} requires a managed SkillWiki write command`, () => {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(
        /skillwiki page publish|managed command|skillwiki archive|skillwiki log-append|skillwiki index rebuild/.test(text),
      ).toBe(true);
    });
  }

  it("does not restore the direct page then index then log sequence", () => {
    for (const relative of REQUIRED) {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(text).not.toMatch(/write (?:the )?(?:query|typed|final) page[\s\S]{0,300}update `?index\.md`?[\s\S]{0,300}(?:update|append).*`?log\.md`?/i);
    }
  });

  it("keeps pasted text ingest runnable through an external staged source", () => {
    for (const relative of PASTED_TEXT_INGEST_SOURCES) {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(text).toContain("temporary file outside the vault");
      expect(text).toContain("skillwiki ingest <staged-paste-path>");
      expect(text).toContain("retain the staged source and exact command inputs");
      expect(text).toContain("only after `skillwiki ingest` exits 0 after typed-page publication");
    }
  });
});

// packages/skills is the materialize canonical source; codex-skills/root are mirrors.
const SNAPSHOT_SAFETY_SOURCES = [
  "packages/skills/wiki-sync/SKILL.md",
  "packages/skills/proj-decide/SKILL.md",
  "packages/codex-skills/skills/wiki-sync/SKILL.md",
  "packages/codex-skills/skills/proj-decide/SKILL.md",
];

describe("protected snapshot worktree safety contract", () => {
  for (const relative of SNAPSHOT_SAFETY_SOURCES) {
    it(`${relative} forbids agent authoring in /root/wiki-git`, () => {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(text).toMatch(
        /Do not author, copy, edit, stage, commit, pull, reset, or push agent changes[\s\S]{0,40}\/root\/wiki-git/,
      );
      // No executable recovery recipes that reset or rsync into the snapshot worktree.
      expect(text).not.toMatch(/cd\s+(?:~\/wiki-git|\/root\/wiki-git)[\s\S]{0,200}git\s+reset\s+--hard/);
      expect(text).not.toMatch(/^\s*rsync\s+[^\n]*\/root\/wiki-git/m);
      // Forbid bare instructional push lines; allow explicit "Do not run …" prohibitions.
      const instructionalPush = text
        .split("\n")
        .filter((line) => /skillwiki\s+sync\s+push\s+\/root\/wiki(?:-git)?\b/.test(line))
        .filter((line) => !/\bdo\s+\*\*not\*\*\s+run\b|\bdo not run\b|\bnever\b|\brefuse\b|\bnot\b/i.test(line));
      expect(instructionalPush).toEqual([]);
    });
  }

  it("proj-decide requires project-page publish for architecture ADRs", () => {
    for (const relative of [
      "packages/skills/proj-decide/SKILL.md",
      "packages/codex-skills/skills/proj-decide/SKILL.md",
    ]) {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(text).toContain("skillwiki project-page publish");
      expect(text).toContain("--write --approve");
    }
  });
});
