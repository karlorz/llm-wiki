import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeCanonicalUrl } from "./config.js";
import type { DuplicateSignals } from "./dedupe.js";
import type { SynthesisOutput, TaskProposal } from "./synthesis.js";
import { err, ok, type Result } from "./types.js";

export interface ProposalDuplicateSuppression {
  title: string;
  reasons: string[];
}

export interface RenderProposalCapturesInput {
  vault: string;
  project: string;
  runDate: string;
  manifestPath: string;
  output: SynthesisOutput;
  duplicateSignals: DuplicateSignals;
}

export interface RenderProposalCapturesOutput {
  renderedPaths: string[];
  validationErrors: string[];
  duplicateSuppressions: ProposalDuplicateSuppression[];
}

export function renderProposalCaptures(input: RenderProposalCapturesInput): Result<RenderProposalCapturesOutput> {
  try {
    const validationErrors = input.output.proposalErrors ?? [];
    if (validationErrors.length > 0) {
      updateManifest(input, [], validationErrors, []);
      return ok({ renderedPaths: [], validationErrors, duplicateSuppressions: [] });
    }

    const renderedPaths: string[] = [];
    const duplicateSuppressions: ProposalDuplicateSuppression[] = [];
    for (const proposal of input.output.proposals) {
      const reasons = duplicateReasons(proposal, input.duplicateSignals);
      if (reasons.length > 0) {
        duplicateSuppressions.push({ title: proposal.title, reasons });
        continue;
      }
      if (renderedPaths.length >= 3) continue;
      const path = uniqueCapturePath(input.vault, input.runDate, proposal);
      writeCapture(input.vault, path, input.project, input.runDate, proposal);
      renderedPaths.push(path);
    }

    updateManifest(input, renderedPaths, [], duplicateSuppressions);
    return ok({ renderedPaths, validationErrors: [], duplicateSuppressions });
  } catch (error) {
    return err("CAPTURE_RENDER_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function duplicateReasons(proposal: TaskProposal, signals: DuplicateSignals): string[] {
  const reasons: string[] = [];
  const sourceUrls = proposal.sourceUrls.map(normalizeCanonicalUrl);

  for (const task of signals.existingTasks) {
    if (task.sourceUrl && sourceUrls.includes(normalizeCanonicalUrl(task.sourceUrl))) {
      reasons.push(`duplicate source URL already captured in ${task.path}`);
    }
  }

  for (const work of signals.activeWork) {
    if (work.sourceUrls.some((url) => sourceUrls.includes(normalizeCanonicalUrl(url)))) {
      reasons.push(`duplicate source URL already active in ${work.path}`);
    }
  }

  for (const digest of signals.recentDigests) {
    if (digest.sourceUrls.some((url) => sourceUrls.includes(normalizeCanonicalUrl(url)))) {
      reasons.push(`duplicate source URL already covered in ${digest.path}`);
    }
  }

  return unique(reasons);
}

function writeCapture(vault: string, path: string, project: string, runDate: string, proposal: TaskProposal): void {
  const fullPath = join(vault, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, renderCaptureBody(project, runDate, proposal), "utf8");
}

function renderCaptureBody(project: string, runDate: string, proposal: TaskProposal): string {
  return [
    "---",
    `source_url: ${JSON.stringify(proposal.sourceUrls[0] ?? "")}`,
    `ingested: ${runDate}`,
    `kind: ${proposal.captureKind}`,
    `project: "[[${project}]]"`,
    "---",
    "",
    `# ${proposal.title}`,
    "",
    "## Problem",
    "",
    proposal.problem,
    "",
    "## Requirements Or Questions",
    "",
    ...proposal.requirementsOrQuestions.map((item) => `- ${item}`),
    "",
    "## Acceptance",
    "",
    ...proposal.acceptance.map((item) => `- ${item}`),
    "",
    "## Evidence",
    "",
    ...proposal.evidence.flatMap((item) => [
      `- Source: ${item.sourceUrl}`,
      `  - Excerpt: ${JSON.stringify(item.excerpt)}`,
      `  - Supports: ${item.supportsClaim}`,
      `  - Confidence: ${item.confidence}`,
    ]),
    "",
    "## Affected Surfaces",
    "",
    ...proposal.affectedSurfaces.map((surface) => `- ${surface}`),
    "",
  ].join("\n");
}

function uniqueCapturePath(vault: string, runDate: string, proposal: TaskProposal): string {
  const slug = slugify(proposal.title);
  const base = `raw/transcripts/${runDate}-${proposal.captureKind}-${slug}`;
  let path = `${base}.md`;
  let index = 2;
  while (existsSync(join(vault, path))) {
    path = `${base}-${index}.md`;
    index += 1;
  }
  return path;
}

function updateManifest(
  input: RenderProposalCapturesInput,
  renderedPaths: string[],
  validationErrors: string[],
  duplicateSuppressions: ProposalDuplicateSuppression[]
): void {
  const path = join(input.vault, input.manifestPath);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const outputs = isRecord(manifest.outputs) ? manifest.outputs : {};

  const changedFiles = stringArray(manifest.changed_files ?? manifest.changedFiles);
  manifest.changed_files = unique([...changedFiles, ...renderedPaths]).sort((left, right) => left.localeCompare(right));
  outputs.task_capture_paths = renderedPaths;
  outputs.task_capture_renderer = "typescript";
  manifest.outputs = outputs;
  manifest.proposal_validation_errors = validationErrors;
  manifest.proposal_duplicate_suppressions = duplicateSuppressions;

  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "proposal";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
