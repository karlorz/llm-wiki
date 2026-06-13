import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectDuplicateSignals,
  evaluateDuplicateCandidate,
  type ActiveWorkSignal,
  type DuplicateSignals,
  type ExistingTaskSignal,
  type RecentDigestSignal,
} from "./dedupe.js";
import type { SelectedGithubCandidate } from "./github.js";
import { err, ok, type Result } from "./types.js";

export interface AllowedOutputs {
  evidencePath: string;
  digestPath: string;
  taskCaptureGlob: string;
  manifestPath: string;
}

export interface BuildAgentInputArgs {
  vault: string;
  repo: string;
  project: string;
  runDate: string;
  runId: string;
  selectedCandidates: SelectedGithubCandidate[];
  allowedOutputs: AllowedOutputs;
  duplicateSignals?: DuplicateSignals;
}

export interface DuplicateSuppression {
  candidate: SelectedGithubCandidate;
  reasons: string[];
}

export interface AgentInput {
  vault: string;
  repo: string;
  project: string;
  runDate: string;
  runId: string;
  selectedCandidates: SelectedGithubCandidate[];
  duplicateSuppressions: DuplicateSuppression[];
  existingTasks: ExistingTaskSignal[];
  activeWork: ActiveWorkSignal[];
  recentDigests: RecentDigestSignal[];
  allowedOutputs: AllowedOutputs;
  manifestPath: string;
}

export interface WriteAgentInputOutput {
  path: string;
}

export function buildAgentInput(args: BuildAgentInputArgs): Result<AgentInput> {
  const signals = args.duplicateSignals ?? collectDuplicateSignals(args.vault, args.project);
  if ("ok" in signals) {
    if (!signals.ok) return signals;
    return buildAgentInput({ ...args, duplicateSignals: signals.data });
  }

  const selectedCandidates: SelectedGithubCandidate[] = [];
  const duplicateSuppressions: DuplicateSuppression[] = [];
  for (const candidate of args.selectedCandidates) {
    const decision = evaluateDuplicateCandidate(candidate, signals);
    if (decision.duplicate) duplicateSuppressions.push({ candidate, reasons: decision.reasons });
    else selectedCandidates.push(candidate);
  }

  return ok({
    vault: args.vault,
    repo: args.repo,
    project: args.project,
    runDate: args.runDate,
    runId: args.runId,
    selectedCandidates,
    duplicateSuppressions,
    existingTasks: signals.existingTasks,
    activeWork: signals.activeWork,
    recentDigests: signals.recentDigests,
    allowedOutputs: args.allowedOutputs,
    manifestPath: args.allowedOutputs.manifestPath,
  });
}

export function writeAgentInput(input: AgentInput): Result<WriteAgentInputOutput> {
  try {
    const dir = join(input.vault, ".skillwiki", "agent-memory-trends");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${input.runDate}-input.json`);
    writeFileSync(path, JSON.stringify(agentInputToWire(input), null, 2) + "\n", "utf8");
    return ok({ path });
  } catch (error) {
    return err("INPUT_WRITE_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export function agentInputToWire(input: AgentInput): Record<string, unknown> {
  return {
    vault: input.vault,
    repo: input.repo,
    project: input.project,
    run_date: input.runDate,
    run_id: input.runId,
    selected_candidates: input.selectedCandidates.map(candidateToWire),
    duplicate_suppressions: input.duplicateSuppressions.map((suppression) => ({
      candidate: candidateToWire(suppression.candidate),
      reasons: suppression.reasons,
    })),
    existing_tasks: input.existingTasks.map((task) => ({
      path: task.path,
      title: task.title,
      source_url: task.sourceUrl,
      repo_name: task.repoName,
    })),
    active_work: input.activeWork.map((work) => ({
      path: work.path,
      title: work.title,
      status: work.status,
      source_urls: work.sourceUrls,
      repo_names: work.repoNames,
    })),
    recent_digests: input.recentDigests.map((digest) => ({
      path: digest.path,
      title: digest.title,
      source_urls: digest.sourceUrls,
      repo_names: digest.repoNames,
    })),
    allowed_outputs: {
      evidence_path: input.allowedOutputs.evidencePath,
      digest_path: input.allowedOutputs.digestPath,
      task_capture_glob: input.allowedOutputs.taskCaptureGlob,
      manifest_path: input.allowedOutputs.manifestPath,
    },
    manifest_path: input.manifestPath,
  };
}

function candidateToWire(candidate: SelectedGithubCandidate): Record<string, unknown> {
  return {
    name: candidate.name,
    full_name: candidate.fullName,
    canonical_url: candidate.canonicalUrl,
    description: candidate.description,
    topics: candidate.topics,
    stargazers_count: candidate.stargazersCount,
    forks_count: candidate.forksCount,
    pushed_at: candidate.pushedAt,
    archived: candidate.archived,
    query_ids: candidate.queryIds,
    lane_ids: candidate.laneIds,
    quality_gate: candidate.qualityGate,
    evidence_families: candidate.evidenceFamilies,
    readme_evidence: (candidate.readmeEvidence ?? []).map((evidence) => ({
      source_url: evidence.sourceUrl,
      excerpt: evidence.excerpt,
      supports_claim: evidence.supportsClaim,
      confidence: evidence.confidence,
    })),
    score: {
      score: candidate.score.score,
      components: {
        relevance: candidate.score.components.relevance,
        implementation_evidence: candidate.score.components.implementationEvidence,
        authority_momentum: candidate.score.components.authorityMomentum,
        freshness: candidate.score.components.freshness,
        novelty_or_tracking: candidate.score.components.noveltyOrTracking,
      },
      tracking_status: candidate.score.trackingStatus,
      reasons: candidate.score.reasons,
    },
  };
}
