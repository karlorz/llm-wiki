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
  ".claude/research-cycle-controller.md",
];
const PASTED_TEXT_INGEST_SOURCES = [
  "packages/skills/wiki-ingest/SKILL.md",
  "packages/skills/agents/wiki-ingest.md",
];

describe("managed writer publication contract", () => {
  for (const relative of REQUIRED) {
    it(`${relative} requires the transactional page publisher`, () => {
      const text = readFileSync(resolve(ROOT, relative), "utf8");
      expect(text).toContain("skillwiki page publish");
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
