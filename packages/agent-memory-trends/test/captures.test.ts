import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderProposalCaptures } from "../src/captures.js";
import type { DuplicateSignals } from "../src/dedupe.js";
import type { SynthesisOutput, TaskProposal } from "../src/synthesis.js";

function writeVaultFile(vault: string, relPath: string, body: string): void {
  const fullPath = join(vault, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function seedManifest(vault: string): string {
  const manifestPath = ".skillwiki/agent-memory-trends/2026-06-11-run.json";
  writeVaultFile(
    vault,
    manifestPath,
    JSON.stringify(
      {
        run_date: "2026-06-11",
        status: "success",
        changed_files: [
          "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
          "queries/2026-06-11-agent-memory-trends-digest.md",
          manifestPath,
        ],
        outputs: {
          evidence_path: "raw/articles/2026-06-11-agent-memory-trends-evidence.md",
          digest_path: "queries/2026-06-11-agent-memory-trends-digest.md",
          run_state_path: manifestPath,
        },
        web_sources: ["https://github.com/acme/local-agent-memory#readme"],
      },
      null,
      2
    ) + "\n"
  );
  return manifestPath;
}

function duplicateSignals(overrides: Partial<DuplicateSignals> = {}): DuplicateSignals {
  return {
    existingTasks: [],
    activeWork: [],
    recentDigests: [],
    ...overrides,
  };
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    title: "Add local agent memory bridge",
    captureKind: "task",
    problem: "The README-backed source shows a local cross-agent memory bridge worth evaluating.",
    requirementsOrQuestions: ["Inspect the source contract before implementation."],
    acceptance: ["A reviewed work item exists only after source inspection confirms the pattern applies."],
    evidence: [
      {
        sourceUrl: "https://github.com/acme/local-agent-memory#readme",
        excerpt: "Local-first agent memory for Claude and Codex sessions.",
        supportsClaim: "The README describes local-first cross-agent memory.",
        confidence: "medium",
      },
    ],
    affectedSurfaces: ["agent-memory-trends", "raw-captures"],
    sourceUrls: ["https://github.com/acme/local-agent-memory#readme"],
    ...overrides,
  };
}

describe("TypeScript-rendered proposal captures", () => {
  it("renders schema-compatible raw captures and marks the manifest as TypeScript-rendered", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-captures-"));
    const manifestPath = seedManifest(vault);
    const output: SynthesisOutput = { proposals: [proposal()] };

    const result = renderProposalCaptures({
      vault,
      project: "llm-wiki",
      runDate: "2026-06-11",
      manifestPath,
      output,
      duplicateSignals: duplicateSignals(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected captures to render");
    expect(result.data.renderedPaths).toEqual([
      "raw/transcripts/2026-06-11-task-add-local-agent-memory-bridge.md",
    ]);
    const body = readFileSync(join(vault, result.data.renderedPaths[0]), "utf8");
    expect(body).toContain("kind: task");
    expect(body).toContain('project: "[[llm-wiki]]"');
    expect(body).toContain("## Evidence");
    expect(body).toContain("Confidence: medium");

    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    expect(manifest.changed_files).toContain("raw/transcripts/2026-06-11-task-add-local-agent-memory-bridge.md");
    expect(manifest.outputs.task_capture_paths).toEqual([
      "raw/transcripts/2026-06-11-task-add-local-agent-memory-bridge.md",
    ]);
    expect(manifest.outputs.task_capture_renderer).toBe("typescript");
  });

  it("suppresses all captures when proposal validation failed upstream", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-captures-"));
    const manifestPath = seedManifest(vault);

    const result = renderProposalCaptures({
      vault,
      project: "llm-wiki",
      runDate: "2026-06-11",
      manifestPath,
      output: {
        proposals: [proposal()],
        proposalErrors: ["proposals[0].evidence must contain at least one item"],
      },
      duplicateSignals: duplicateSignals(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected suppression success");
    expect(result.data.renderedPaths).toEqual([]);
    expect(result.data.validationErrors).toEqual(["proposals[0].evidence must contain at least one item"]);
    expect(existsSync(join(vault, "raw/transcripts/2026-06-11-task-add-local-agent-memory-bridge.md"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    expect(manifest.outputs.task_capture_paths).toEqual([]);
    expect(manifest.proposal_validation_errors).toEqual(["proposals[0].evidence must contain at least one item"]);
  });

  it("suppresses post-proposal duplicates without treating them as validation failures", () => {
    const vault = mkdtempSync(join(tmpdir(), "agent-memory-trends-captures-"));
    const manifestPath = seedManifest(vault);

    const result = renderProposalCaptures({
      vault,
      project: "llm-wiki",
      runDate: "2026-06-11",
      manifestPath,
      output: {
        proposals: [
          proposal(),
          proposal({
            title: "Evaluate docs guide memory transfer",
            captureKind: "idea",
            sourceUrls: ["https://github.com/acme/docs-guide#readme"],
            evidence: [
              {
                sourceUrl: "https://github.com/acme/docs-guide#readme",
                excerpt: "Documentation guide for autonomous workflow memory transfer.",
                supportsClaim: "The README describes a docs-guide workflow relevant to agent skills.",
                confidence: "low",
              },
            ],
            affectedSurfaces: ["docs-guide"],
          }),
        ],
      },
      duplicateSignals: duplicateSignals({
        existingTasks: [
          {
            path: "raw/transcripts/2026-06-10-task-local-agent-memory.md",
            title: "Add local agent memory bridge",
            sourceUrl: "https://github.com/acme/local-agent-memory#readme",
            repoName: "acme/local-agent-memory",
          },
        ],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected duplicate suppression success");
    expect(result.data.renderedPaths).toEqual([
      "raw/transcripts/2026-06-11-idea-evaluate-docs-guide-memory-transfer.md",
    ]);
    expect(result.data.duplicateSuppressions).toEqual([
      {
        title: "Add local agent memory bridge",
        reasons: [
          "duplicate source URL already captured in raw/transcripts/2026-06-10-task-local-agent-memory.md",
        ],
      },
    ]);
    const manifest = JSON.parse(readFileSync(join(vault, manifestPath), "utf8"));
    expect(manifest.proposal_duplicate_suppressions).toEqual(result.data.duplicateSuppressions);
    expect(manifest.proposal_validation_errors).toEqual([]);
  });
});
