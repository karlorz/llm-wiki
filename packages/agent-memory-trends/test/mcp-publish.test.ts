import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planMcpPublication,
  publishGeneratedOutputsToMcp,
  type McpToolCaller,
} from "../src/mcp-publish.js";

const RUN_DATE = "2026-09-17";
const MANIFEST_PATH = `.skillwiki/agent-memory-trends/${RUN_DATE}-run.json`;

function write(vault: string, path: string, content: string): void {
  const target = join(vault, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function fixture(changedFiles?: string[]): string {
  const vault = mkdtempSync(join(tmpdir(), "agent-memory-mcp-publish-"));
  const digestPath = `queries/${RUN_DATE}-agent-memory-trends-digest.md`;
  const capturePath = `raw/transcripts/${RUN_DATE}-task-review-memory-index.md`;
  const evidencePath = `raw/articles/${RUN_DATE}-agent-memory-trends-evidence-run-1.md`;
  const files = changedFiles ?? [
    `.skillwiki/agent-memory-trends/${RUN_DATE}-input.json`,
    MANIFEST_PATH,
    ".skillwiki/agent-memory-trends/latest-run.json",
    digestPath,
    capturePath,
    evidencePath,
  ];
  write(
    vault,
    digestPath,
    `---\ntitle: Agent Memory Trends - ${RUN_DATE}\ncreated: ${RUN_DATE}\nupdated: ${RUN_DATE}\ntype: query\nname: agent-memory-trends-${RUN_DATE}\ntags: [agent-memory, query]\nprovenance: research\nconfidence: medium\noverview: Test digest.\nsources: []\n---\n\n# Digest\n`
  );
  write(
    vault,
    capturePath,
    `---\nsource_url: "https://example.test/source"\ningested: ${RUN_DATE}\nkind: task\nproject: "[[llm-wiki]]"\n---\n\n# Review memory index\n\n## Problem\n\nThe index needs review.\n`
  );
  write(vault, evidencePath, "# host-local evidence\n");
  write(vault, `.skillwiki/agent-memory-trends/${RUN_DATE}-input.json`, "{}\n");
  write(vault, ".skillwiki/agent-memory-trends/latest-run.json", "{}\n");
  write(
    vault,
    MANIFEST_PATH,
    JSON.stringify(
      {
        run_date: RUN_DATE,
        status: "success",
        changed_files: files,
        outputs: {
          digest_path: digestPath,
          evidence_path: evidencePath,
          task_capture_paths: [capturePath],
          task_capture_renderer: "typescript",
          run_state_path: MANIFEST_PATH,
          latest_run_path: ".skillwiki/agent-memory-trends/latest-run.json",
        },
        web_sources: [],
      },
      null,
      2
    ) + "\n"
  );
  return vault;
}

describe("HTTP MCP publication planning", () => {
  it("maps generate-only digest and captures while retaining denied artifact classes as host-local state", () => {
    const vault = fixture();
    const planned = planMcpPublication({ vault, runDate: RUN_DATE, manifestPath: MANIFEST_PATH, project: "llm-wiki" });

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.data.actions.map((action) => [action.tool, action.path])).toEqual([
      ["wiki_page_publish", `queries/${RUN_DATE}-agent-memory-trends-digest.md`],
      ["wiki_capture", `raw/transcripts/${RUN_DATE}-task-review-memory-index.md`],
    ]);
    expect(planned.data.hostLocalPaths).toEqual([
      `.skillwiki/agent-memory-trends/${RUN_DATE}-input.json`,
      `.skillwiki/agent-memory-trends/${RUN_DATE}-run.json`,
      ".skillwiki/agent-memory-trends/latest-run.json",
      `raw/articles/${RUN_DATE}-agent-memory-trends-evidence-run-1.md`,
    ]);
  });

  it.each([
    "index.md",
    "projects/llm-wiki/architecture/fleet.yaml",
    ".skillwiki/not-declared.json",
    `raw/articles/${RUN_DATE}-unrelated.md`,
  ])("rejects denied or undeclared MCP target %s", (path) => {
    const vault = fixture([path]);
    const planned = planMcpPublication({ vault, runDate: RUN_DATE, manifestPath: MANIFEST_PATH, project: "llm-wiki" });
    expect(planned).toMatchObject({ ok: false, error: "PATH_DENIED" });
  });

  it("publishes with CAS, converts captures, and proves the sg01-research writer receipt", async () => {
    const vault = fixture();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callTool: McpToolCaller = async (name, args) => {
      calls.push({ name, args });
      if (name === "wiki_read_page") return { ok: false, error: "FILE_NOT_FOUND", path: String(args.path) };
      if (name === "wiki_page_publish") return { ok: true, path: String(args.path) };
      if (name === "wiki_capture") return { ok: true, path: `raw/transcripts/${RUN_DATE}-task-server-path.md`, writer_id: "sg01-research" };
      if (name === "wiki_status") return { ok: true, writer_id: "sg01-research" };
      return { ok: false, error: "UNEXPECTED_TOOL" };
    };

    const published = await publishGeneratedOutputsToMcp({
      vault,
      runDate: RUN_DATE,
      manifestPath: MANIFEST_PATH,
      project: "llm-wiki",
      callTool,
      expectedWriterId: "sg01-research",
    });

    expect(published).toMatchObject({
      ok: true,
      data: { writerId: "sg01-research", quietRun: false },
    });
    expect(calls.map((call) => call.name)).toEqual([
      "wiki_read_page",
      "wiki_page_publish",
      "wiki_capture",
      "wiki_status",
    ]);
    expect(calls.find((call) => call.name === "wiki_capture")?.args).toMatchObject({
      kind: "task",
      project: "llm-wiki",
      title: "Review memory index",
    });
  });

  it("returns an explicit quiet-run receipt without attempting a write", async () => {
    const vault = fixture([
      `.skillwiki/agent-memory-trends/${RUN_DATE}-input.json`,
      MANIFEST_PATH,
      ".skillwiki/agent-memory-trends/latest-run.json",
    ]);
    const calls: string[] = [];
    const published = await publishGeneratedOutputsToMcp({
      vault,
      runDate: RUN_DATE,
      manifestPath: MANIFEST_PATH,
      project: "llm-wiki",
      expectedWriterId: "sg01-research",
      callTool: async (name) => {
        calls.push(name);
        return name === "wiki_status"
          ? { ok: true, writer_id: "sg01-research" }
          : { ok: false, error: "UNEXPECTED_TOOL" };
      },
    });
    expect(published).toMatchObject({ ok: true, data: { quietRun: true, writerId: "sg01-research" } });
    expect(calls).toEqual(["wiki_status"]);
  });
});
