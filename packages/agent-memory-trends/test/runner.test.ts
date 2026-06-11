import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInput } from "../src/input.js";
import {
  buildCodexExecRequest,
  loadCodexSynthesisPrompt,
  runCodexSynthesis,
  type CodexRunResult,
  type CodexRunner,
} from "../src/runner.js";

function inputFixture(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    vault: "/vault",
    repo: "/repo/llm-wiki",
    project: "llm-wiki",
    runDate: "2026-06-11",
    runId: "2026-06-11T00-10-00+08-00",
    selectedCandidates: [],
    duplicateSuppressions: [],
    existingTasks: [],
    activeWork: [],
    recentDigests: [],
    allowedOutputs: {
      evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
      digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
      taskCaptureGlob: "raw/transcripts/2026-06-11-task-*.md",
      manifestPath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
    },
    manifestPath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
    ...overrides,
  };
}

describe("Codex synthesis runner", () => {
  it("loads a prompt that encodes the publisher contract and web-source cap", () => {
    const prompt = loadCodexSynthesisPrompt();

    expect(prompt).toContain("0-3 task captures");
    expect(prompt).toContain("max 15");
    expect(prompt).toContain("run manifest");
    expect(prompt).toContain("publisher gate");
    expect(prompt).toContain("Do not modify existing raw files");
  });

  it("composes prompt plus input JSON through stdin and uses the required codex exec flags", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-memory-trends-runner-"));
    const lastMessagePath = join(tmp, "last-message.md");
    const request = buildCodexExecRequest({
      input: inputFixture(),
      tmpDir: tmp,
      outputLastMessagePath: lastMessagePath,
    });

    expect(request.args).toEqual([
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--sandbox",
      "workspace-write",
      "--cd",
      "/vault",
      "--add-dir",
      "/repo/llm-wiki",
      "--add-dir",
      tmp,
      "--output-last-message",
      lastMessagePath,
      "-",
    ]);
    expect(request.stdin).toContain("# Agent Memory Trends Codex Synthesis");
    expect(request.stdin).toContain("BEGIN_AGENT_MEMORY_TRENDS_INPUT_JSON");
    expect(request.stdin).toContain('"run_id": "2026-06-11T00-10-00+08-00"');
    expect(request.stdin).toContain("END_AGENT_MEMORY_TRENDS_INPUT_JSON");
    expect(request.cwd).toBe("/vault");
  });

  it("omits raw README text from the Codex input payload", () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-memory-trends-runner-"));
    const request = buildCodexExecRequest({
      input: inputFixture({
        selectedCandidates: [
          {
            name: "huge-agent",
            fullName: "example/huge-agent",
            canonicalUrl: "https://github.com/example/huge-agent",
            description: "Agent memory project",
            topics: ["agent", "memory"],
            stargazersCount: 42,
            forksCount: 7,
            pushedAt: "2026-06-10T12:00:00Z",
            archived: false,
            queryIds: ["agent-memory"],
            readmeText: "README ".repeat(10_000),
            score: {
              score: 31,
              components: {
                relevance: 12,
                actionability: 7,
                authorityActivity: 5,
                freshness: 4,
                novelty: 3,
              },
              reasons: ["relevance: 12/35 for agent memory match"],
            },
          },
        ],
      }),
      tmpDir: tmp,
      outputLastMessagePath: join(tmp, "last-message.md"),
    });

    const wireJson = request.stdin.split("BEGIN_AGENT_MEMORY_TRENDS_INPUT_JSON\n")[1]?.split("\nEND_AGENT_MEMORY_TRENDS_INPUT_JSON")[0];
    expect(wireJson).toBeTruthy();
    expect(wireJson).not.toContain("readmeText");
    expect(wireJson).not.toContain("README README");
    expect(JSON.parse(wireJson ?? "{}").selected_candidates[0]).toMatchObject({
      full_name: "example/huge-agent",
      canonical_url: "https://github.com/example/huge-agent",
      stargazers_count: 42,
      score: {
        components: {
          authority_activity: 5,
        },
      },
    });
  });

  it("runs Codex through an injected command and requires the manifest output", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-memory-trends-runner-"));
    const vault = join(tmp, "vault");
    const repo = join(tmp, "repo");
    mkdirSync(join(vault, ".skillwiki", "agent-memory-trends"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    const input = inputFixture({
      vault,
      repo,
      manifestPath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      allowedOutputs: {
        evidencePath: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
        digestPath: "queries/2026-06-11-agent-memory-trends-digest.md",
        taskCaptureGlob: "raw/transcripts/2026-06-11-task-*.md",
        manifestPath: ".skillwiki/agent-memory-trends/2026-06-11-run.json",
      },
    });

    const calls: Array<{ args: string[]; stdin: string; cwd: string }> = [];
    const runner: CodexRunner = async (args, options): Promise<CodexRunResult> => {
      calls.push({ args, stdin: options.stdin, cwd: options.cwd });
      writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-11-run.json"), '{"ok":true}\n', "utf8");
      return { exitCode: 0, stdout: "done", stderr: "" };
    };

    const result = await runCodexSynthesis({
      input,
      tmpDir: tmp,
      outputLastMessagePath: join(tmp, "last-message.md"),
      runCodex: runner,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected runner success");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain("exec");
    expect(calls[0].stdin).toContain('"allowed_outputs"');
    expect(result.data.manifestPath).toBe(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-11-run.json"));
  });
});
