import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInput } from "../src/input.js";
import {
  buildCodexExecRequest,
  createCodexSynthesisRunner,
  loadCodexSynthesisPrompt,
  runCodexSynthesis,
  type CodexRunResult,
  type CodexRunner,
} from "../src/runner.js";
import type { SynthesisRunner } from "../src/synthesis.js";

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

    expect(prompt).toContain("Return structured JSON");
    expect(prompt).toContain("capture_kind");
    expect(prompt).toContain("Do not write raw/transcripts");
    expect(prompt).toContain("metadata-only");
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
            laneIds: ["weekly_momentum"],
            qualityGate: "passed",
            evidenceFamilies: ["coding_agent", "memory_state", "skills_subagents"],
            readmeEvidence: [
              {
                sourceUrl: "https://github.com/example/huge-agent#readme",
                excerpt: "Agent memory hooks for Codex and Claude using local Markdown.",
                supportsClaim: "README evidence mentions cross-agent memory hooks.",
                confidence: "medium",
              },
            ],
            score: {
              score: 31,
              components: {
                relevance: 12,
                implementationEvidence: 7,
                authorityMomentum: 5,
                freshness: 4,
                noveltyOrTracking: 3,
              },
              trackingStatus: "new",
              reasons: ["relevance: 12/30 for agent memory match"],
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
      lane_ids: ["weekly_momentum"],
      quality_gate: "passed",
      evidence_families: ["coding_agent", "memory_state", "skills_subagents"],
      stargazers_count: 42,
      readme_evidence: [
        {
          source_url: "https://github.com/example/huge-agent#readme",
          excerpt: "Agent memory hooks for Codex and Claude using local Markdown.",
          supports_claim: "README evidence mentions cross-agent memory hooks.",
          confidence: "medium",
        },
      ],
      score: {
        components: {
          authority_momentum: 5,
          implementation_evidence: 7,
          novelty_or_tracking: 3,
        },
        tracking_status: "new",
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

  it("adapts Codex exec behind the neutral SynthesisRunner boundary", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "agent-memory-trends-runner-"));
    const vault = join(tmp, "vault");
    const repo = join(tmp, "repo");
    const outputLastMessagePath = join(tmp, "last-message.md");
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

    const codexRunner: CodexRunner = async () => {
      writeFileSync(join(vault, ".skillwiki", "agent-memory-trends", "2026-06-11-run.json"), '{"ok":true}\n', "utf8");
      writeFileSync(
        outputLastMessagePath,
        JSON.stringify({
          proposals: [
            {
              title: "Evaluate local agent memory bridge",
              capture_kind: "idea",
              problem: "A source-backed memory bridge may be relevant, but needs inspection first.",
              requirements_or_questions: ["Inspect the source and decide whether the pattern applies."],
              acceptance: ["A human-reviewed decision exists before implementation work is queued."],
              evidence: [
                {
                  source_url: "https://github.com/acme/local-agent-memory#readme",
                  excerpt: "Local-first agent memory for Claude and Codex sessions.",
                  supports_claim: "The README describes local-first cross-agent memory.",
                  confidence: "medium",
                },
              ],
              affected_surfaces: ["agent-memory-trends"],
              source_urls: ["https://github.com/acme/local-agent-memory#readme"],
            },
          ],
        }),
        "utf8"
      );
      return { exitCode: 0, stdout: "done", stderr: "" };
    };
    const runner: SynthesisRunner = createCodexSynthesisRunner(codexRunner);

    const result = await runner({ input, tmpDir: tmp, outputLastMessagePath });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected synthesis success");
    expect(result.data.output.proposals).toHaveLength(1);
    expect(result.data.output.proposals[0]).toMatchObject({
      title: "Evaluate local agent memory bridge",
      captureKind: "idea",
      affectedSurfaces: ["agent-memory-trends"],
    });
  });
});
