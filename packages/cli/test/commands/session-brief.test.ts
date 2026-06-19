import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionBrief } from "../../src/commands/session-brief.js";

async function makeVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "session-brief-vault-"));
  writeFileSync(join(vault, "SCHEMA.md"), "# Schema\n");
  writeFileSync(join(vault, "index.md"), "# Index\n\n## Meta\n");
  writeFileSync(join(vault, "log.md"), "# Log\n");
  mkdirSync(join(vault, "meta"), { recursive: true });
  mkdirSync(join(vault, ".skillwiki"), { recursive: true });
  mkdirSync(join(vault, "queries"), { recursive: true });
  mkdirSync(join(vault, "raw", "transcripts"), { recursive: true });
  mkdirSync(join(vault, "projects", "llm-wiki", "work", "2026-06-11-agent-memory-trends-workflow"), { recursive: true });

  writeFileSync(join(vault, "raw", "transcripts", "2026-06-10-session-log-cli.md"), `---
source_url:
ingested: 2026-06-10
kind: session-log
project: "[[llm-wiki]]"
---

Session added schema support and prepared session brief work.
`);
  writeFileSync(join(vault, "raw", "transcripts", "2026-06-11-task-memory-trends.md"), `---
source_url:
ingested: 2026-06-11
kind: task
project: "[[llm-wiki]]"
---

Stage agent memory trends improvements for llm-wiki.
`);
  writeFileSync(join(vault, "projects", "llm-wiki", "work", "2026-06-11-agent-memory-trends-workflow", "spec.md"), `---
title: Agent Memory Trends Workflow
created: 2026-06-11
updated: 2026-06-11
started: 2026-06-11
kind: feature
status: planned
priority: high
project: "[[llm-wiki]]"
---

Build session brief and nightly agent memory trends workflow.
`);
  writeFileSync(join(vault, "queries", "2026-06-11-agent-memory-trends-digest.md"), `---
title: Agent Memory Trends Digest
created: 2026-06-11
updated: 2026-06-11
type: query
tags: [agent-memory]
sources: [raw/articles/2026-06-11-agent-memory-trends-evidence.md]
---

Daily digest identified Claude memory and Codex session continuity projects.
`);

  return vault;
}

describe("runSessionBrief", () => {
  it("renders a bounded read-only brief for the current project", async () => {
    const vault = await makeVault();
    writeFileSync(join(vault, ".skillwiki", "health.json"), JSON.stringify({
      status: "warn",
      warnings: ["vault lint has info buckets", "session brief cache is stale"]
    }, null, 2));

    const result = await runSessionBrief({ vault, project: "llm-wiki", write: false });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.project).toBe("llm-wiki");
    expect(result.result.data.brief).toContain("Session Brief");
    expect(result.result.data.brief).toContain("Agent Memory Trends Workflow");
    expect(result.result.data.brief).toContain("Stage agent memory trends improvements");
    expect(result.result.data.brief).toContain("vault lint has info buckets");
    expect(result.result.data.word_count).toBeLessThanOrEqual(900);
    expect(existsSync(join(vault, "meta", "latest-session-brief.md"))).toBe(false);
    expect(existsSync(join(vault, ".skillwiki", "session-brief.md"))).toBe(false);
  });

  it("writes committed and cache artifacts, with idempotent index and material log updates", async () => {
    const vault = await makeVault();

    const first = await runSessionBrief({ vault, project: "llm-wiki", write: true });
    const second = await runSessionBrief({ vault, project: "llm-wiki", write: true });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(existsSync(join(vault, "meta", "latest-session-brief.md"))).toBe(true);
    expect(existsSync(join(vault, ".skillwiki", "session-brief.md"))).toBe(true);
    expect(existsSync(join(vault, ".skillwiki", "session-brief.json"))).toBe(true);

    const committed = readFileSync(join(vault, "meta", "latest-session-brief.md"), "utf8");
    expect(committed).toContain("generated_kind: session-brief");
    expect(committed).toContain("generated_by: skillwiki session-brief");
    expect(committed).toContain("tags: [meta, session-brief]");
    expect(committed).not.toContain("tags: [generated, session-brief]");
    expect(committed).toContain("# Session Brief");

    const cache = JSON.parse(readFileSync(join(vault, ".skillwiki", "session-brief.json"), "utf8"));
    expect(cache.project).toBe("llm-wiki");
    expect(cache.brief).toContain("Session Brief");

    const index = readFileSync(join(vault, "index.md"), "utf8");
    expect(index.match(/\[\[meta\/latest-session-brief\]\]/g)).toHaveLength(1);

    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(log.match(/session-brief \| refreshed: meta\/latest-session-brief\.md/g)).toHaveLength(1);
  });

  it("renders memory topic pointers from the derived project cache", async () => {
    const vault = await makeVault();
    mkdirSync(join(vault, ".skillwiki", "memory", "llm-wiki"), { recursive: true });
    writeFileSync(join(vault, ".skillwiki", "memory", "llm-wiki", "topics.json"), `${JSON.stringify({
      generated_at: "2026-06-19T00:00:00Z",
      project: "llm-wiki",
      topics: [
        {
          name: "session-brief",
          summary: "Startup memory and topic retrieval boundary.",
          project: "llm-wiki",
          updated: "2026-06-19",
          paths: [
            "concepts/agent-memory-control-loop.md",
            "projects/llm-wiki/compound/session-brief-nightly-refresh-boundary.md",
          ],
        },
      ],
      sources: [],
    }, null, 2)}\n`, "utf8");

    const result = await runSessionBrief({ vault, project: "llm-wiki", write: true });

    expect(result.exitCode).toBe(0);
    expect(result.result.ok).toBe(true);
    if (!result.result.ok) throw new Error("expected ok");
    expect(result.result.data.brief).toContain("## Memory Topics");
    expect(result.result.data.brief).toContain("session-brief");
    expect(result.result.data.brief).toContain("skillwiki memory recall --project llm-wiki --topic session-brief");
    expect(result.result.data.memory_topics).toHaveLength(1);

    const cache = JSON.parse(readFileSync(join(vault, ".skillwiki", "session-brief.json"), "utf8"));
    expect(cache.memory_topics).toEqual([
      {
        name: "session-brief",
        summary: "Startup memory and topic retrieval boundary.",
        project: "llm-wiki",
        updated: "2026-06-19",
        paths: [
          "concepts/agent-memory-control-loop.md",
          "projects/llm-wiki/compound/session-brief-nightly-refresh-boundary.md",
        ],
      },
    ]);
  });

  it("appends log entries for later material changes, not timestamp-only refreshes", async () => {
    const vault = await makeVault();

    await runSessionBrief({ vault, project: "llm-wiki", write: true });
    await runSessionBrief({ vault, project: "llm-wiki", write: true });

    writeFileSync(join(vault, "raw", "transcripts", "2026-06-12-task-new-memory-source.md"), `---
source_url:
ingested: 2026-06-12
kind: task
project: "[[llm-wiki]]"
---

Review a new memory source candidate.
`);

    await runSessionBrief({ vault, project: "llm-wiki", write: true });

    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(log.match(/session-brief \| refreshed: meta\/latest-session-brief\.md/g)).toHaveLength(2);
  });

  it("does not append a log entry when only committed brief timestamps changed", async () => {
    const vault = await makeVault();

    await runSessionBrief({ vault, project: "llm-wiki", write: true });
    const metaPath = join(vault, "meta", "latest-session-brief.md");
    const previous = readFileSync(metaPath, "utf8")
      .replace(/^created: .+$/m, "created: 2026-01-01")
      .replace(/^updated: .+$/m, "updated: 2026-01-01")
      .replace(/^generated_at: .+$/m, "generated_at: 2026-01-01T00:00:00Z")
      .replace(/^Generated: .+$/m, "Generated: 2026-01-01T00:00:00Z");
    writeFileSync(metaPath, previous);

    await runSessionBrief({ vault, project: "llm-wiki", write: true });

    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(log.match(/session-brief \| refreshed: meta\/latest-session-brief\.md/g)).toHaveLength(1);
  });

  it("detects project from SKILLWIKI_PROJECT, project dotenv, and vault project path", async () => {
    const vault = await makeVault();

    const envResult = await runSessionBrief({
      vault,
      project: "auto",
      env: { SKILLWIKI_PROJECT: "llm-wiki" }
    });
    expect(envResult.result.ok).toBe(true);
    if (!envResult.result.ok) throw new Error("expected ok");
    expect(envResult.result.data.project).toBe("llm-wiki");

    const cwdWithDotenv = await mkdtemp(join(tmpdir(), "session-brief-cwd-"));
    mkdirSync(join(cwdWithDotenv, ".skillwiki"), { recursive: true });
    writeFileSync(join(cwdWithDotenv, ".skillwiki", ".env"), "PROJECT_SLUG=llm-wiki\n");
    const dotenvResult = await runSessionBrief({
      vault,
      project: "auto",
      cwd: cwdWithDotenv,
      env: {}
    });
    expect(dotenvResult.result.ok).toBe(true);
    if (!dotenvResult.result.ok) throw new Error("expected ok");
    expect(dotenvResult.result.data.project).toBe("llm-wiki");

    const inferredCwd = join(vault, "projects", "llm-wiki", "work", "2026-06-11-agent-memory-trends-workflow");
    const inferredResult = await runSessionBrief({
      vault,
      project: "auto",
      cwd: inferredCwd,
      env: {}
    });
    expect(inferredResult.result.ok).toBe(true);
    if (!inferredResult.result.ok) throw new Error("expected ok");
    expect(inferredResult.result.data.project).toBe("llm-wiki");
  });
});
