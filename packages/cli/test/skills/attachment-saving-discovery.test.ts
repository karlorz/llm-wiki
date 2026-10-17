import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLIP_NOT_CONFIGURED } from "../../src/utils/clip-outbox-config.js";
import { MCP_ONLY_LEAF_SKIP } from "../../src/doctor/probes/helpers.js";

const ROOT = resolve(__dirname, "../../../..");
const RUNBOOK = "packages/skills/using-skillwiki/references/save-attachments.md";
const POINTER = "using-skillwiki/references/save-attachments.md";
const ENTRY_POINTS = [
  "packages/skills/using-skillwiki/SKILL.md",
  "packages/skills/using-skillwiki/activation.md",
  "packages/skills/skillwiki-mcp/SKILL.md",
  "packages/skills/wiki-add-task/SKILL.md",
  "packages/skills/wiki-ingest/SKILL.md",
  "packages/skills/agents/wiki-add-task.md",
  "packages/skills/agents/wiki-ingest.md",
];

function readRepo(relative: string): string {
  return readFileSync(resolve(ROOT, relative), "utf8");
}

function clipOutboxHelpFromCliSource(cliRaw = readRepo("packages/cli/src/cli.ts")): Record<string, string> {
  const cli = cliRaw.replace(/\r\n/g, "\n");
  const start = cli.indexOf('const clipOutboxCmd = program.command("clip-outbox")');
  expect(start).toBeGreaterThan(-1);
  const nextProgram = cli.indexOf("\nprogram\n", start);
  const nextConst = cli.indexOf("\nconst ", start + 1);
  const ends = [nextProgram, nextConst].filter((n) => n > start);
  const block = cli.slice(start, ends.length ? Math.min(...ends) : undefined);
  const help: Record<string, string> = {};
  const commandRe =
    /clipOutboxCmd\s*\n\s*\.command\("([^"]+)"\)\s*\n\s*\.description\("([^"]+)"\)/g;
  for (const match of block.matchAll(commandRe)) {
    help[match[1]!] = match[2]!;
  }
  return help;
}

describe("attachment-saving discovery", () => {
  it("keeps one canonical runbook next to using-skillwiki", () => {
    const runbook = readRepo(RUNBOOK);
    expect(runbook).toContain(CLIP_NOT_CONFIGURED);
    expect(runbook).toContain(MCP_ONLY_LEAF_SKIP);
    expect(runbook).toContain("s3_verified=true");
    expect(runbook).toContain("central-visible");
    expect(runbook).toContain("notify-pending");
    expect(runbook).toContain("transfer pending");
    expect(runbook).toContain("packages/cli/docs/clip-outbox.md");
  });

  it("points Codex, Claude, Grok, and Cursor entry points at that runbook", () => {
    for (const relative of ENTRY_POINTS) {
      expect(readRepo(relative), `${relative} must name the canonical runbook`).toContain(POINTER);
    }
  });

  it("states the missing-MCP-upload distinction at session-start and MCP entry points", () => {
    for (const relative of [
      "packages/skills/using-skillwiki/SKILL.md",
      "packages/skills/using-skillwiki/activation.md",
      "packages/skills/skillwiki-mcp/SKILL.md",
      RUNBOOK,
    ]) {
      expect(readRepo(relative), `${relative} must distinguish missing MCP upload from unsupported images`).toMatch(
        /no binary-upload|binary-upload MCP tool/i,
      );
    }
  });

  it("quotes clip-outbox help from CLI source and does not invent upload commands", () => {
    const expected = ["install-or-migrate", "mirror-watch", "status", "watch"];
    const source = readRepo("packages/cli/src/cli.ts");
    const lf = clipOutboxHelpFromCliSource(source.replace(/\r\n/g, "\n"));
    const crlf = clipOutboxHelpFromCliSource(source.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
    expect(Object.keys(lf).sort()).toEqual(expected);
    expect(Object.keys(crlf).sort()).toEqual(expected);
    const runbook = readRepo(RUNBOOK);
    for (const [name, description] of Object.entries(lf)) {
      expect(runbook).toContain(`| \`${name}\` | ${description} |`);
    }
    expect(runbook).toMatch(/Agent may run[\s\S]*status[\s\S]*Yes/i);
    expect(runbook).toContain("Do not run `watch`, `mirror-watch`, or `install-or-migrate` unless the user explicitly asks to operate that infrastructure.");
    expect(runbook).not.toMatch(/skillwiki clip-outbox upload\b/);
    expect(runbook).not.toMatch(/wiki_upload\b/);
    expect(runbook).not.toMatch(/skillwiki image\b/);
  });

  it("covers the required routing cases with precise progress labels", () => {
    const runbook = readRepo(RUNBOOK);
    const required = [
      "MCP has no binary-upload tool; `clip-outbox status` is enabled",
      "Discover this route without a user hint",
      "MCP-only leaf — check skipped",
      "Do not rclone, copy credentials, write the frozen wiki, or invent an upload service",
      "clip channel not configured",
      "production clip watcher not loaded and enabled",
      "Stop at that prerequisite",
      "Report **transfer pending**, not complete",
      "That reference is not a portable attachment",
      "Expect a sibling `note.md`",
      "Distinguish ordinary Markdown `![](url)` from Obsidian `![[raw/assets/...]]`",
      "Do not claim rendering",
      "local archive saved",
      "bundle staged",
      "transfer acknowledged",
      "centrally visible",
      "central note verified",
      "mirrored binary hash verified",
      "reader rendering verified",
      "The worker never infers `mirrored`",
    ];
    for (const needle of required) {
      expect(runbook, `runbook missing routing evidence: ${needle}`).toContain(needle);
    }
  });

  it("keeps wiki-add-task from treating binaries as transcript capture", () => {
    const text = readRepo("packages/skills/wiki-add-task/SKILL.md");
    expect(text).toContain("wiki_capture");
    expect(text).toMatch(/frozen-leaf hosts capture via MCP `?wiki_capture`?/i);
    expect(text).toContain("Generated images and other binaries are not `wiki_capture` content");
    expect(text).not.toMatch(/If the capture includes images or other binaries, store those files under `raw\/assets\/`/);
  });
});
