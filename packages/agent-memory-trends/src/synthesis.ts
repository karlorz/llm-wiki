import type { AgentInput } from "./input.js";
import { err, ok, type Result } from "./types.js";

export const CAPTURE_KINDS = ["task", "bug", "idea"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const AFFECTED_SURFACES = [
  "session-brief",
  "agent-memory-trends",
  "raw-captures",
  "work-items",
  "lint-validation",
  "plugin-startup",
  "vault-sync",
  "docs-guide",
] as const;
export type AffectedSurface = (typeof AFFECTED_SURFACES)[number];

export const EVIDENCE_CONFIDENCES = ["high", "medium", "low"] as const;
export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number];

export interface ProposalEvidence {
  sourceUrl: string;
  excerpt: string;
  supportsClaim: string;
  confidence: EvidenceConfidence;
}

export interface TaskProposal {
  title: string;
  captureKind: CaptureKind;
  problem: string;
  requirementsOrQuestions: string[];
  acceptance: string[];
  evidence: ProposalEvidence[];
  affectedSurfaces: AffectedSurface[];
  sourceUrls: string[];
}

export interface SynthesisOutput {
  proposals: TaskProposal[];
  proposalErrors?: string[];
}

export type SynthesisBackend = "codex" | "claude";

export interface SynthesisTelemetry {
  invoked: boolean;
  primaryBackend: SynthesisBackend;
  primaryAttempts: number;
  primaryFailed: boolean;
  fallbackBackend: SynthesisBackend | null;
  fallbackAvailable: boolean;
  fallbackInvoked: boolean;
  resultBackend: SynthesisBackend | null;
  failureCode: string | null;
  primaryErrorCode: string | null;
  fallbackErrorCode: string | null;
}

export interface SynthesisRequest {
  input: AgentInput;
  tmpDir: string;
  outputLastMessagePath: string;
}

export interface SynthesisRunOutput {
  manifestPath: string;
  outputLastMessagePath: string;
  stdout: string;
  stderr: string;
  output: SynthesisOutput;
  synthesis?: SynthesisTelemetry;
}

export type SynthesisRunner = (request: SynthesisRequest) => Promise<Result<SynthesisRunOutput>>;

export function parseSynthesisOutput(text: string): Result<SynthesisOutput> {
  const parsed = parseJsonFromText(text);
  if (!parsed.ok) return parsed;
  if (!isRecord(parsed.data)) return err("SYNTHESIS_OUTPUT_INVALID", "output must be a JSON object");
  const proposals = validateTaskProposals(parsed.data.proposals);
  if (!proposals.ok) return proposals;
  return ok({ proposals: proposals.data });
}

export function validateTaskProposals(value: unknown): Result<TaskProposal[]> {
  if (!Array.isArray(value)) return err("PROPOSAL_VALIDATION_FAILED", "proposals must be an array");

  const errors: string[] = [];
  const proposals = value.map((item, index) => normalizeProposal(item, `proposals[${index}]`, errors));
  if (errors.length > 0) return err("PROPOSAL_VALIDATION_FAILED", errors.join("; "));
  return ok(proposals.filter((proposal): proposal is TaskProposal => proposal !== undefined));
}

function normalizeProposal(value: unknown, path: string, errors: string[]): TaskProposal | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }

  const captureKind = enumField(value.capture_kind ?? value.captureKind, CAPTURE_KINDS, `${path}.capture_kind`, errors);
  const evidence = evidenceArray(value.evidence, `${path}.evidence`, errors);
  const affectedSurfaces = enumArray(value.affected_surfaces ?? value.affectedSurfaces, AFFECTED_SURFACES, `${path}.affected_surfaces`, errors);
  if (!captureKind || !evidence || !affectedSurfaces) return undefined;

  return {
    title: stringField(value.title, `${path}.title`, errors),
    captureKind,
    problem: stringField(value.problem, `${path}.problem`, errors),
    requirementsOrQuestions: stringArray(value.requirements_or_questions ?? value.requirementsOrQuestions, `${path}.requirements_or_questions`, errors),
    acceptance: stringArray(value.acceptance, `${path}.acceptance`, errors),
    evidence,
    affectedSurfaces,
    sourceUrls: stringArray(value.source_urls ?? value.sourceUrls, `${path}.source_urls`, errors),
  };
}

function parseJsonFromText(text: string): Result<unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const source = fenced || trimmed;
  try {
    return ok(JSON.parse(source) as unknown);
  } catch (error) {
    return err("SYNTHESIS_OUTPUT_INVALID", error instanceof Error ? error.message : String(error));
  }
}

function evidenceArray(value: unknown, path: string, errors: string[]): ProposalEvidence[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  if (value.length === 0) errors.push(`${path} must contain at least one item`);

  const items: ProposalEvidence[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemPath} must be an object`);
      return;
    }
    const confidence = enumField(item.confidence, EVIDENCE_CONFIDENCES, `${itemPath}.confidence`, errors);
    if (!confidence) return;
    items.push({
      sourceUrl: stringField(item.source_url ?? item.sourceUrl, `${itemPath}.source_url`, errors),
      excerpt: stringField(item.excerpt, `${itemPath}.excerpt`, errors),
      supportsClaim: stringField(item.supports_claim ?? item.supportsClaim, `${itemPath}.supports_claim`, errors),
      confidence,
    });
  });

  return items;
}

function enumArray<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  errors: string[]
): Array<T[number]> | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return undefined;
  }
  const items: Array<T[number]> = [];
  value.forEach((item, index) => {
    const parsed = enumField(item, allowed, `${path}[${index}]`, errors);
    if (parsed) items.push(parsed);
  });
  return items;
}

function enumField<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  errors: string[]
): T[number] | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  errors.push(`${path} must be one of ${allowed.join(", ")}`);
  return undefined;
}

function stringField(value: unknown, path: string, errors: string[]): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  errors.push(`${path} must be a non-empty string`);
  return "";
}

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  if (strings.length !== value.length || strings.length === 0) errors.push(`${path} must contain non-empty strings`);
  return strings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
