import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = join(__dirname, "..", "..", "..", "..");
const SKILLS = join(REPO, "packages", "skills");
const CLI_DIST = join(REPO, "packages", "cli", "dist", "cli.js");

const ALL_SKILLS = [
  "wiki-init", "wiki-ingest", "wiki-query", "wiki-lint", "wiki-crystallize", "wiki-audit",
  "proj-init", "proj-work", "proj-distill", "proj-decide"
];

describe("Definition of Done", () => {
  it("all 10 SKILL.md files exist", () => {
    for (const s of ALL_SKILLS) expect(existsSync(join(SKILLS, s, "SKILL.md"))).toBe(true);
  });

  it("CLI binary exists and is built", () => {
    expect(existsSync(CLI_DIST)).toBe(true);
  });

  it("all 4 templates exist", () => {
    const T = join(REPO, "packages", "cli", "templates");
    for (const t of ["SCHEMA.md", "index.md", "log.md", "project-README.md"]) {
      expect(existsSync(join(T, t))).toBe(true);
    }
  });

  it("no bash scripts remain in the repo", () => {
    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
          out.push(...walk(join(dir, e.name)));
        } else if (e.isFile() && e.name.endsWith(".sh")) {
          out.push(join(dir, e.name));
        }
      }
      return out;
    }
    expect(walk(REPO)).toEqual([]);
  });

  it("README does not reference install.sh", () => {
    expect(readFileSync(join(REPO, "README.md"), "utf8")).not.toMatch(/install\.sh/);
  });

  it("fetch-guard CLI rejects http with exit 4", () => {
    let status = 0;
    try { execFileSync("node", [CLI_DIST, "fetch-guard", "http://example.com"], { encoding: "utf8" }); }
    catch (e: any) { status = e.status; }
    expect(status).toBe(4);
  });
});
