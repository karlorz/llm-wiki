import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentInput } from "./input.js";
import { materializeOperationalRunManifest } from "./publish.js";
import { err, ok, type Result } from "./types.js";

export interface MaterializePreviewRunInput {
  vault: string;
  runDate: string;
  inputPath: string;
  input: AgentInput;
}

export interface MaterializePreviewRunOutput {
  changedFiles: string[];
}

export function materializePreviewRun(input: MaterializePreviewRunInput): Result<MaterializePreviewRunOutput> {
  const changedFiles = [
    input.inputPath,
    input.input.allowedOutputs.digestPath,
    input.input.allowedOutputs.evidencePath,
    input.input.manifestPath,
  ];

  try {
    writeVaultFile(input.vault, input.input.allowedOutputs.evidencePath, renderPreviewEvidence(input.input));
    writeVaultFile(input.vault, input.input.allowedOutputs.digestPath, renderPreviewDigest(input.input));
    writeVaultFile(input.vault, input.input.manifestPath, JSON.stringify(previewManifest(input.input, changedFiles), null, 2) + "\n");
  } catch (error) {
    return err("PREVIEW_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }

  const materialized = materializeOperationalRunManifest({
    vault: input.vault,
    runDate: input.runDate,
    manifestPath: input.input.manifestPath,
    extraChangedFiles: changedFiles,
  });
  if (!materialized.ok) return materialized;
  return ok({ changedFiles: materialized.data.changedFiles });
}

function writeVaultFile(vault: string, path: string, body: string): void {
  const fullPath = join(vault, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, "utf8");
}

function previewManifest(input: AgentInput, changedFiles: string[]): Record<string, unknown> {
  return {
    run_date: input.runDate,
    run_id: input.runId,
    status: "success",
    mode: "preview-only",
    selected_candidate_count: input.selectedCandidates.length,
    duplicate_suppression_count: input.duplicateSuppressions.length,
    proposal_count: 0,
    task_proposal_count: 0,
    idea_proposal_count: 0,
    bug_proposal_count: 0,
    task_capture_count: 0,
    changed_files: changedFiles,
    outputs: {
      evidence_path: input.allowedOutputs.evidencePath,
      digest_path: input.allowedOutputs.digestPath,
      run_state_path: input.manifestPath,
      manifest_path: input.manifestPath,
      task_capture_paths: [],
      task_capture_renderer: "typescript",
    },
    web_sources: candidateSourceUrls(input),
    duplicate_suppressions: input.duplicateSuppressions.map((suppression) => ({
      repo_name: suppression.candidate.fullName,
      source_url: suppression.candidate.canonicalUrl,
      reasons: suppression.reasons,
    })),
  };
}

function renderPreviewEvidence(input: AgentInput): string {
  return [
    "---",
    `source_url: ${JSON.stringify(`generated:agent-memory-trends-preview/${input.runId}`)}`,
    `ingested: ${input.runDate}`,
    "ingested_by: agent-memory-trends-preview",
    "---",
    "",
    `# Agent Memory Trends Preview Evidence - ${input.runDate}`,
    "",
    `Deterministic preview evidence for \`${input.project}\` run \`${input.runId}\`.`,
    "",
    "This file was generated without invoking the synthesis agent. It uses only selected GitHub candidate metadata and bounded README evidence already present in the collector input.",
    "",
    "## Declared Web Sources",
    "",
    ...candidateSourceUrls(input).map((url, index) => `${index + 1}. ${url}`),
    "",
    "## Candidate Evidence",
    "",
    ...input.selectedCandidates.flatMap((candidate, index) => renderPreviewEvidenceCandidate(candidate, index + 1)),
    "",
    "## Duplicate Suppressions",
    "",
    ...(input.duplicateSuppressions.length > 0
      ? input.duplicateSuppressions.flatMap((suppression) => [
          `- ${suppression.candidate.fullName}`,
          ...suppression.reasons.map((reason) => `  - ${reason}`),
        ])
      : ["No duplicate suppressions were supplied by the collector."]),
    "",
  ].join("\n");
}

function renderPreviewEvidenceCandidate(candidate: AgentInput["selectedCandidates"][number], index: number): string[] {
  return [
    `### ${index}. ${candidate.fullName}`,
    "",
    `- Source: ${previewSourceUrl(candidate)}`,
    `- Description: ${candidate.description || "(no description)"}`,
    `- Topics: ${candidate.topics.length > 0 ? candidate.topics.join(", ") : "none supplied"}`,
    `- Stars/forks: ${candidate.stargazersCount} / ${candidate.forksCount}`,
    `- Last push: ${candidate.pushedAt || "unknown"}`,
    `- Lanes: ${candidate.laneIds.join(", ")}`,
    `- Queries: ${candidate.queryIds.join(", ")}`,
    `- Quality gate: ${candidate.qualityGate}`,
    `- Evidence families: ${candidate.evidenceFamilies.join(", ")}`,
    ...previewEvidenceQualityLines(candidate),
    `- Score: ${candidate.score.score}`,
    ...previewReadmeEvidenceLines(candidate),
    "",
  ];
}

function renderPreviewDigest(input: AgentInput): string {
  const evidencePath = input.allowedOutputs.evidencePath;
  return [
    "---",
    `title: "Agent Memory Trends Preview - ${input.runDate}"`,
    `created: ${input.runDate}`,
    `updated: ${input.runDate}`,
    "type: query",
    `name: agent-memory-trends-preview-${input.runDate}`,
    "tags: [agent-memory, llm-wiki, trends, github, query, provenance/research, confidence/low, preview]",
    "provenance: research",
    "confidence: low",
    "overview: Deterministic local preview of selected GitHub trend candidates without synthesis-agent proposals.",
    "sources:",
    `  - "${evidencePath}"`,
    "---",
    "",
    `# Agent Memory Trends Preview - ${input.runDate}`,
    "",
    `> **TL;DR:** Deterministic preview selected ${input.selectedCandidates.length} candidate(s). It did not invoke the synthesis agent and did not create task captures.`,
    "",
    "## Selected Candidates",
    "",
    ...input.selectedCandidates.flatMap((candidate, index) => renderPreviewDigestCandidate(candidate, index + 1)),
    "",
    "## Duplicate Suppression",
    "",
    input.duplicateSuppressions.length > 0
      ? `${input.duplicateSuppressions.length} candidate(s) were suppressed before preview output.`
      : "No candidates were suppressed before preview output.",
    "",
    "## Preview Limits",
    "",
    "This preview is deterministic and bounded. It is intended for local development smoke checks of recall/ranking only; production daily synthesis still uses the synthesis runner for proposal judgement.",
    "",
    `Source details are listed in the aggregate evidence file.^[${evidencePath}]`,
    "",
  ].join("\n");
}

function renderPreviewDigestCandidate(candidate: AgentInput["selectedCandidates"][number], index: number): string[] {
  return [
    `### ${index}. ${candidate.fullName}`,
    "",
    `- Source: ${candidate.canonicalUrl}`,
    `- Score: ${candidate.score.score}`,
    `- Tracking: ${candidate.score.trackingStatus}`,
    `- Stars/forks: ${candidate.stargazersCount} / ${candidate.forksCount}`,
    `- Lanes: ${candidate.laneIds.join(", ")}`,
    `- Evidence families: ${candidate.evidenceFamilies.join(", ")}`,
    ...previewEvidenceQualityLines(candidate),
    `- Description: ${candidate.description || "(no description)"}`,
    "",
  ];
}

function candidateSourceUrls(input: AgentInput): string[] {
  return [...new Set(input.selectedCandidates.map(previewSourceUrl))];
}

function previewSourceUrl(candidate: AgentInput["selectedCandidates"][number]): string {
  return candidate.readmeEvidence?.[0]?.sourceUrl || `${candidate.canonicalUrl}#readme`;
}

function previewReadmeEvidenceLines(candidate: AgentInput["selectedCandidates"][number]): string[] {
  const evidence = candidate.readmeEvidence ?? [];
  if (evidence.length === 0) return ["- README evidence: none supplied"];
  return evidence.flatMap((item) => [
    `- README evidence source: ${item.sourceUrl}`,
    `- README excerpt: ${JSON.stringify(item.excerpt)}`,
    `- README supports: ${item.supportsClaim}`,
    `- README confidence: ${item.confidence}`,
  ]);
}

function previewEvidenceQualityLines(candidate: AgentInput["selectedCandidates"][number]): string[] {
  const quality = candidate.evidenceQuality;
  return [
    `- Evidence quality: ${quality.depth}`,
    `- Source inspection: ${quality.sourceInspectionRecommended ? "recommended" : "not recommended"}`,
    `- Evidence signals: ${quality.signals.length > 0 ? quality.signals.join(", ") : "none"}`,
    `- Evidence summary: ${quality.summary}`,
  ];
}
