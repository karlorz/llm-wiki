import { describe, expect, it } from "vitest";
import {
  AFFECTED_SURFACES,
  CAPTURE_KINDS,
  parseSynthesisOutput,
  validateTaskProposals,
  type SynthesisRunner,
} from "../src/synthesis.js";

function validProposal() {
  return {
    title: "Add bounded README evidence to agent memory trends",
    capture_kind: "task",
    problem: "The nightly job can create task captures from repository metadata alone.",
    requirements_or_questions: [
      "Carry bounded README excerpts into synthesis input.",
      "Keep full README bodies out of the prompt payload.",
    ],
    acceptance: [
      "Task captures are rendered only when at least one evidence item supports the claim.",
    ],
    evidence: [
      {
        source_url: "https://github.com/acme/local-agent-memory#readme",
        excerpt: "Local-first agent memory for Claude and Codex sessions using Markdown files.",
        supports_claim: "The README describes cross-agent session memory backed by local Markdown.",
        confidence: "medium",
      },
    ],
    affected_surfaces: ["agent-memory-trends", "raw-captures"],
    source_urls: ["https://github.com/acme/local-agent-memory#readme"],
  };
}

describe("agent-neutral synthesis proposal contract", () => {
  it("uses neutral shared names for the runner boundary", async () => {
    const runner: SynthesisRunner = async (request) => ({
      ok: true,
      data: {
        manifestPath: `${request.input.vault}/${request.input.manifestPath}`,
        outputLastMessagePath: request.outputLastMessagePath,
        stdout: "",
        stderr: "",
        output: { proposals: [] },
      },
    });

    const result = await runner({
      input: {
        vault: "/vault",
        repo: "/repo",
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
      },
      tmpDir: "/tmp/agent-memory-trends",
      outputLastMessagePath: "/tmp/agent-memory-trends/last-message.md",
    });

    expect(result.ok).toBe(true);
    expect(CAPTURE_KINDS).toEqual(["task", "bug", "idea"]);
    expect(AFFECTED_SURFACES).toContain("agent-memory-trends");
  });

  it("validates complete task proposals and normalizes snake_case agent output", () => {
    const result = validateTaskProposals([validProposal()]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid proposal");
    expect(result.data).toEqual([
      {
        title: "Add bounded README evidence to agent memory trends",
        captureKind: "task",
        problem: "The nightly job can create task captures from repository metadata alone.",
        requirementsOrQuestions: [
          "Carry bounded README excerpts into synthesis input.",
          "Keep full README bodies out of the prompt payload.",
        ],
        acceptance: [
          "Task captures are rendered only when at least one evidence item supports the claim.",
        ],
        evidence: [
          {
            sourceUrl: "https://github.com/acme/local-agent-memory#readme",
            excerpt: "Local-first agent memory for Claude and Codex sessions using Markdown files.",
            supportsClaim: "The README describes cross-agent session memory backed by local Markdown.",
            confidence: "medium",
          },
        ],
        affectedSurfaces: ["agent-memory-trends", "raw-captures"],
        sourceUrls: ["https://github.com/acme/local-agent-memory#readme"],
      },
    ]);
  });

  it("fails all proposals when any proposal is missing primary-source evidence", () => {
    const invalid = { ...validProposal(), evidence: [] };
    const result = validateTaskProposals([validProposal(), invalid]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid proposals");
    expect(result.error).toBe("PROPOSAL_VALIDATION_FAILED");
    expect(String(result.detail)).toContain("proposals[1].evidence must contain at least one item");
  });

  it("rejects malformed capture kinds and affected surfaces", () => {
    const invalid = {
      ...validProposal(),
      capture_kind: "work-item",
      affected_surfaces: ["agent-memory-trends", "claude-only-runner"],
    };
    const result = validateTaskProposals([invalid]);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid proposal");
    expect(String(result.detail)).toContain("capture_kind must be one of task, bug, idea");
    expect(String(result.detail)).toContain("affected_surfaces[1] must be one of");
  });

  it("parses structured proposals from the runner last-message JSON", () => {
    const result = parseSynthesisOutput([
      "Agent finished. Structured output follows.",
      "```json",
      JSON.stringify({ proposals: [validProposal()] }),
      "```",
    ].join("\n"));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected parsed synthesis output");
    expect(result.data.proposals).toHaveLength(1);
    expect(result.data.proposals[0].captureKind).toBe("task");
  });
});
